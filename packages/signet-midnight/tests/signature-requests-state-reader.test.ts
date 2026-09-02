// Round-trip test for the MPC-style raw state reader: encode a request with
// the canonical descriptors into a synthetic StateValue tree (the shape the
// indexer returns for a contract address), then decode it back by field
// position alone, with no compiled contract involved. The reader measures
// each record's capacity instantiation (calldata words, access-list entries,
// storage keys per entry) from the cell's declared alignment widths, so
// records with and without access lists are both exercised.

import {
  type AlignedValue,
  CompactTypeUnsignedInteger,
  StateMap,
  StateValue,
} from "@midnight-ntwrk/compact-runtime";
import { describe, expect, it } from "vitest";

import {
  calculateRequestId,
  evmAddressAbiWord,
  lookupSignetRequestAt,
  MPCDestination,
  MPCSignatureAlgorithm,
  numericAbiWord,
  readSignetRequestsIndexFromState,
  requestIdHex,
  type SignBidirectionalEvent,
  TxParamType,
} from "../src/index.ts";
import { signBidirectionalEventDescriptor } from "../src/signet-evtype2tx-requests.ts";
// Package-internal descriptors, imported from their defining modules.
import { requestIdType } from "../src/signet-requests.ts";

// The ERC20 transfer(address,uint256) selector: a realistic calldata fixture
// (the app-level constant lives in the cli).
const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

// Shared across tests: NEVER mutate. Build a variation as an explicit spread.
// The vault's shape: <2 calldata words, 0 access-list entries, 0 keys> with
// 34-byte schemas.
const SAMPLE_REQUEST: SignBidirectionalEvent = {
  sender: { bytes: bytes(32, 0x01) },
  keyVersion: 1n,
  path: bytes(32, 0x03),
  algo: MPCSignatureAlgorithm.ecdsa,
  dest: MPCDestination.unused,
  params: bytes(64, 0x06),
  txParamType: TxParamType.evmType2,
  txParams: {
    to: bytes(20, 0xaa),
    chainId: 11155111n,
    nonce: 3n,
    gasLimit: 100000n,
    maxFeePerGas: 30000000000n,
    maxPriorityFeePerGas: 2000000000n,
    value: 0n,
    accessListEntryCount: 0n,
    accessList: [],
    calldata: {
      is_some: true,
      value: {
        selector: ERC20_TRANSFER_SELECTOR,
        noWords: 2n,
        words: [evmAddressAbiWord(bytes(20, 0xee)), numericAbiWord(1_000_000n)],
      },
    },
  },
  caip2Id: bytes(32, 0x02),
  outputDeserializationSchema: bytes(34, 0x07),
  respondSerializationSchema: bytes(34, 0x08),
};

// A wider instantiation: <2 words, 1 access-list entry, 2 storage keys> with
// only one key in use: the reader must recover these capacities too.
const ACCESS_LIST_REQUEST: SignBidirectionalEvent = {
  ...SAMPLE_REQUEST,
  txParams: {
    ...SAMPLE_REQUEST.txParams,
    accessListEntryCount: 1n,
    accessList: [
      {
        address: bytes(20, 0xcc),
        storageKeyCount: 1n,
        storageKeys: [bytes(32, 0x11), bytes(32, 0)],
      },
    ],
  },
};

/** Each request's capacity instantiation, in the descriptor's terms. */
const CAPACITIES = {
  sample: [2, 0, 0],
  accessList: [2, 1, 2],
} as const;

// Real ids: the ledger files each record under its computed id, and
// lookupSignetRequestAt recomputes it and drops mismatches.
const SAMPLE_REQUEST_ID = calculateRequestId(SAMPLE_REQUEST);
const ACCESS_LIST_REQUEST_ID = calculateRequestId(ACCESS_LIST_REQUEST);
// An unrelated counter cell: the neighbour field the index reads must not
// be mistaken for, and the non-Map field the shape errors exercise.
const COUNTER = 8n;

const u64 = new CompactTypeUnsignedInteger(18446744073709551615n, 8);

/** Counter cell as the runtime stores it: a u64 in a plain cell. */
const counterCell = (value: bigint) =>
  StateValue.newCell({ value: u64.toValue(value), alignment: u64.alignment() });

/** A request record cell encoded at the given capacity instantiation. */
const requestCell = (
  request: SignBidirectionalEvent,
  [words, entries, keys]: readonly [number, number, number],
) => {
  const descriptor = signBidirectionalEventDescriptor(
    words,
    entries,
    keys,
    request.outputDeserializationSchema.length,
    request.respondSerializationSchema.length,
  );
  return StateValue.newCell({
    value: descriptor.toValue(request),
    alignment: descriptor.alignment(),
  });
};

/** A one-record request index map: SAMPLE_REQUEST under SAMPLE_REQUEST_ID. */
const sampleIndexMap = () =>
  new StateMap().insert(
    {
      value: requestIdType.toValue(SAMPLE_REQUEST_ID),
      alignment: requestIdType.alignment(),
    },
    requestCell(SAMPLE_REQUEST, CAPACITIES.sample),
  );

// Contract root state: an array of ledger fields with the request index map
// at field 0 and an unrelated counter at field 1 (this synthetic contract's
// own layout: the reader takes the position as an argument).
const syntheticContractState = () => {
  const map = new StateMap()
    .insert(
      {
        value: requestIdType.toValue(SAMPLE_REQUEST_ID),
        alignment: requestIdType.alignment(),
      },
      requestCell(SAMPLE_REQUEST, CAPACITIES.sample),
    )
    .insert(
      {
        value: requestIdType.toValue(ACCESS_LIST_REQUEST_ID),
        alignment: requestIdType.alignment(),
      },
      requestCell(ACCESS_LIST_REQUEST, CAPACITIES.accessList),
    );
  return StateValue.newArray().arrayPush(StateValue.newMap(map)).arrayPush(counterCell(COUNTER));
};

describe("state-reader (MPC-style raw decode)", () => {
  it("round-trips requests through raw state by resolved path", () => {
    const requestsIndex = readSignetRequestsIndexFromState(syntheticContractState(), [0]);

    expect(requestsIndex.size).toBe(2);
    expect(requestsIndex.get(requestIdHex(SAMPLE_REQUEST_ID))).toEqual(SAMPLE_REQUEST);
    expect(requestsIndex.get(requestIdHex(ACCESS_LIST_REQUEST_ID))).toEqual(ACCESS_LIST_REQUEST);
  });

  it("decodes a schema ending in a zero byte at its declared width", () => {
    // The state layer trims trailing zeros off stored atoms: the declared
    // alignment width, not the trimmed atom length, sizes the schema fields.
    const schema = bytes(34, 0x07);
    schema[33] = 0;
    const request: SignBidirectionalEvent = {
      ...SAMPLE_REQUEST,
      respondSerializationSchema: schema,
    };
    const id = calculateRequestId(request);
    const state = StateValue.newArray()
      .arrayPush(
        StateValue.newMap(
          new StateMap().insert(
            {
              value: requestIdType.toValue(id),
              alignment: requestIdType.alignment(),
            },
            requestCell(request, CAPACITIES.sample),
          ),
        ),
      )
      .arrayPush(counterCell(0n));

    const requestsIndex = readSignetRequestsIndexFromState(state, [0]);
    expect(requestsIndex.get(requestIdHex(id))).toEqual(request);
  });

  it("returns an empty index for a fresh contract", () => {
    const fresh = StateValue.newArray()
      .arrayPush(StateValue.newMap(new StateMap()))
      .arrayPush(counterCell(0n));
    expect(readSignetRequestsIndexFromState(fresh, [0]).size).toBe(0);
  });

  it("reads an index living at a non-zero ledger field", () => {
    // stateWithSecondIndex: index at 0, a counter at 1, a SECOND index at 2.
    const requestsIndex = readSignetRequestsIndexFromState(stateWithSecondIndex(), [2]);
    expect(requestsIndex.size).toBe(1);
    expect(requestsIndex.get(requestIdHex(FIELD2_REQUEST_ID))).toEqual(FIELD2_REQUEST);
  });

  it("resolves the index behind a List-typed field (array node, like a chunk)", () => {
    // A Compact List field is a fixed THREE-slot cons ARRAY node: the same
    // node type a chunk uses. Path-following never inspects a node's width, so
    // a List sitting before the index cannot be mistaken for a chunk level;
    // following [2] lands on the index regardless. Layout: list at field 0,
    // a counter at 1, index at 2.
    const listNode = StateValue.newArray()
      .arrayPush(StateValue.newNull())
      .arrayPush(StateValue.newNull())
      .arrayPush(counterCell(0n));
    const state = StateValue.newArray()
      .arrayPush(listNode)
      .arrayPush(counterCell(COUNTER))
      .arrayPush(StateValue.newMap(sampleIndexMap()));

    const requestsIndex = readSignetRequestsIndexFromState(state, [2]);
    expect(requestsIndex.get(requestIdHex(SAMPLE_REQUEST_ID))).toEqual(SAMPLE_REQUEST);
  });

  it("follows a resolved path into a compiler-chunked root (16 fields -> chunks of 1 + 15)", () => {
    // compactc chunks a >15-field contract remainder-FIRST into a
    // depth-uniform tree: 16 fields -> [chunk(1), chunk(15)]. A notification
    // carries the resolved path compactc records in contract-info.json, so the
    // reader follows it node for node with no chunk detection.
    const chunk0 = StateValue.newArray().arrayPush(StateValue.newMap(sampleIndexMap()));
    let chunk1 = StateValue.newArray().arrayPush(counterCell(COUNTER));
    for (let i = 0; i < 14; i += 1) {
      chunk1 = chunk1.arrayPush(StateValue.newNull());
    }
    const state = StateValue.newArray().arrayPush(chunk0).arrayPush(chunk1);

    // Resolved path: index = field 0 at chunk [0, 0].
    const requestsIndex = readSignetRequestsIndexFromState(state, [0, 0]);
    expect(requestsIndex.get(requestIdHex(SAMPLE_REQUEST_ID))).toEqual(SAMPLE_REQUEST);
  });
});

// A second request index living at a NON-ZERO ledger field, so the path
// argument of lookupSignetRequestAt is genuinely exercised. Its member is a
// key-version variation of SAMPLE_REQUEST under its own computed id.
const FIELD2_REQUEST: SignBidirectionalEvent = {
  ...SAMPLE_REQUEST,
  keyVersion: 2n,
};
const FIELD2_REQUEST_ID = calculateRequestId(FIELD2_REQUEST);

/** Contract state: index (field 0), a counter (field 1), a SECOND index (field 2). */
const stateWithSecondIndex = () => {
  const field0 = new StateMap()
    .insert(
      {
        value: requestIdType.toValue(SAMPLE_REQUEST_ID),
        alignment: requestIdType.alignment(),
      },
      requestCell(SAMPLE_REQUEST, CAPACITIES.sample),
    )
    .insert(
      {
        value: requestIdType.toValue(ACCESS_LIST_REQUEST_ID),
        alignment: requestIdType.alignment(),
      },
      requestCell(ACCESS_LIST_REQUEST, CAPACITIES.accessList),
    );
  const field2 = new StateMap().insert(
    {
      value: requestIdType.toValue(FIELD2_REQUEST_ID),
      alignment: requestIdType.alignment(),
    },
    requestCell(FIELD2_REQUEST, CAPACITIES.sample),
  );
  return StateValue.newArray()
    .arrayPush(StateValue.newMap(field0))
    .arrayPush(counterCell(COUNTER))
    .arrayPush(StateValue.newMap(field2));
};

describe("lookupSignetRequestAt", () => {
  it("returns the record for a member id at the right path", () => {
    const request = lookupSignetRequestAt(
      stateWithSecondIndex(),
      [0],
      requestIdHex(SAMPLE_REQUEST_ID),
    );
    expect(request).toEqual(SAMPLE_REQUEST);
  });

  it("resolves a member of the index at a non-zero field", () => {
    const request = lookupSignetRequestAt(
      stateWithSecondIndex(),
      [2],
      requestIdHex(FIELD2_REQUEST_ID),
    );
    expect(request).toEqual(FIELD2_REQUEST);
  });

  it("drops a record filed under an id it does not hash to", () => {
    const spoofedId = bytes(32, 0x5b);
    const state = StateValue.newArray().arrayPush(
      StateValue.newMap(
        new StateMap().insert(
          {
            value: requestIdType.toValue(spoofedId),
            alignment: requestIdType.alignment(),
          },
          requestCell(SAMPLE_REQUEST, CAPACITIES.sample),
        ),
      ),
    );
    expect(lookupSignetRequestAt(state, [0], requestIdHex(spoofedId))).toBeUndefined();
  });

  it("returns undefined for a non-member id", () => {
    expect(
      lookupSignetRequestAt(stateWithSecondIndex(), [0], requestIdHex(bytes(32, 0x99))),
    ).toBeUndefined();
  });

  it("returns undefined for a member looked up at the wrong field", () => {
    // SAMPLE_REQUEST_ID lives at field 0, not field 2.
    expect(
      lookupSignetRequestAt(stateWithSecondIndex(), [2], requestIdHex(SAMPLE_REQUEST_ID)),
    ).toBeUndefined();
  });

  it("returns undefined when the field is not a Map (e.g. a counter cell)", () => {
    expect(
      lookupSignetRequestAt(stateWithSecondIndex(), [1], requestIdHex(SAMPLE_REQUEST_ID)),
    ).toBeUndefined();
  });

  it("returns undefined when the path is out of range", () => {
    expect(
      lookupSignetRequestAt(stateWithSecondIndex(), [9], requestIdHex(SAMPLE_REQUEST_ID)),
    ).toBeUndefined();
  });

  it("agrees byte-for-byte with readSignetRequestsIndexFromState (reader parity)", () => {
    const raw = stateWithSecondIndex();
    const viaReader = readSignetRequestsIndexFromState(raw, [0]).get(
      requestIdHex(SAMPLE_REQUEST_ID),
    );
    expect(lookupSignetRequestAt(raw, [0], requestIdHex(SAMPLE_REQUEST_ID))).toEqual(viaReader);
  });

  // EVM nonce 356 is mined so the computed id ends in 0x00 (guarded below).
  const TRAILING_ZERO_REQUEST: SignBidirectionalEvent = {
    ...SAMPLE_REQUEST,
    txParams: { ...SAMPLE_REQUEST.txParams, nonce: 356n },
  };
  const TRAILING_ZERO_REQUEST_ID = calculateRequestId(TRAILING_ZERO_REQUEST);

  it("resolves a member whose id ends in 0x00 (trimmed-key normal form)", () => {
    // The state layer stores map keys with trailing zeros trimmed, and the
    // lookup constructs its key through the same toValue. This member id's
    // stored key is 31 bytes, so a lookup key built at the full 32 bytes
    // would miss and the resolver would drop a genuine request.
    expect(TRAILING_ZERO_REQUEST_ID[31]).toBe(0);
    const state = StateValue.newArray().arrayPush(
      StateValue.newMap(
        new StateMap().insert(
          {
            value: requestIdType.toValue(TRAILING_ZERO_REQUEST_ID),
            alignment: requestIdType.alignment(),
          },
          requestCell(TRAILING_ZERO_REQUEST, CAPACITIES.sample),
        ),
      ),
    );
    expect(lookupSignetRequestAt(state, [0], requestIdHex(TRAILING_ZERO_REQUEST_ID))).toEqual(
      TRAILING_ZERO_REQUEST,
    );
  });
});

describe("readSignetRequestsIndexFromState: dispatch and shape errors", () => {
  /** A fresh <2,0,0> cell's value/alignment, for tampering per test. */
  const cellsOf = (): AlignedValue => {
    const descriptor = signBidirectionalEventDescriptor(2, 0, 0, 34, 34);
    return { value: descriptor.toValue(SAMPLE_REQUEST), alignment: descriptor.alignment() };
  };

  /** Root state: a request index holding `cell`, with a counter at field 1. */
  const indexStateWithCell = (cell: AlignedValue): StateValue => {
    const id = bytes(32, 0x42);
    const map = new StateMap().insert(
      {
        value: requestIdType.toValue(id),
        alignment: requestIdType.alignment(),
      },
      StateValue.newCell(cell),
    );
    return StateValue.newArray().arrayPush(StateValue.newMap(map)).arrayPush(counterCell(0n));
  };

  it("rejects a cell that ends before the txParamType atom", () => {
    const { value, alignment } = cellsOf();
    expect(() =>
      readSignetRequestsIndexFromState(
        indexStateWithCell({
          value: value.slice(0, 6),
          alignment: alignment.slice(0, 6),
        }),
        [0],
      ),
    ).toThrow(/ends before txParamType/);
  });

  it("rejects a txParamType atom wider than one byte", () => {
    const { value, alignment } = cellsOf();
    // A 2-byte atom needs a matching 2-byte alignment for the state layer to
    // accept the cell; the decoder's width check then rejects it.
    value[6] = Uint8Array.of(0, 1);
    alignment[6] = { tag: "atom", value: { tag: "bytes", length: 2 } };
    expect(() =>
      readSignetRequestsIndexFromState(indexStateWithCell({ value, alignment }), [0]),
    ).toThrow(/txParamType atom holds 2 bytes/);
  });

  it("rejects the reserved txParamType variant", () => {
    const { value, alignment } = cellsOf();
    value[6] = Uint8Array.of(1);
    expect(() =>
      readSignetRequestsIndexFromState(indexStateWithCell({ value, alignment }), [0]),
    ).toThrow(/unsupported txParamType 1/);
  });

  it("rejects a non-Map field as the requests index", () => {
    // Field 1 is a counter cell, not a request map.
    expect(() => readSignetRequestsIndexFromState(syntheticContractState(), [1])).toThrow(
      /is not a Map/,
    );
  });

  it("lookupSignetRequestAt returns undefined for a stored cell that is not a decodable record", () => {
    const { value, alignment } = cellsOf();
    value[6] = Uint8Array.of(1); // the reserved txParamType variant
    const id = bytes(32, 0x43);
    const state = StateValue.newArray().arrayPush(
      StateValue.newMap(
        new StateMap().insert(
          {
            value: requestIdType.toValue(id),
            alignment: requestIdType.alignment(),
          },
          StateValue.newCell({ value, alignment }),
        ),
      ),
    );
    expect(lookupSignetRequestAt(state, [0], requestIdHex(id))).toBeUndefined();
  });

  it("skips an index entry whose value is not a cell", () => {
    const id = bytes(32, 0x44);
    const state = StateValue.newArray()
      .arrayPush(
        StateValue.newMap(
          new StateMap().insert(
            {
              value: requestIdType.toValue(id),
              alignment: requestIdType.alignment(),
            },
            StateValue.newArray(),
          ),
        ),
      )
      .arrayPush(counterCell(0n));
    expect(readSignetRequestsIndexFromState(state, [0]).size).toBe(0);
  });
});
