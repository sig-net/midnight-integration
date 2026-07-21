// Round-trip test for the MPC-style raw state reader: encode a request with
// the canonical descriptors into a synthetic StateValue tree (the shape the
// indexer returns for a contract address), then decode it back by field
// position alone — no compiled contract involved. The reader recovers each
// record's capacity instantiation (calldata words, access-list entries,
// storage keys per entry) from the atom count by candidate enumeration, so
// records with and without access lists are both exercised.

import { describe, expect, it } from "vitest";

import { CompactTypeUnsignedInteger, StateMap, StateValue } from "@midnight-ntwrk/compact-runtime";

import {
  MPCDestination,
  MPCSignatureAlgorithm,
  TxParamType,
  evmAddressAbiWord,
  lookupSignetRequestAt,
  numericAbiWordValue,
  readSignetRequestsLedgerFromState,
  requestIdHex,
  requestIdType,
  signBidirectionalEventDescriptor,
  type SignBidirectionalEvent,
} from "../src/index.ts";

// The ERC20 transfer(address,uint256) selector — a realistic calldata fixture
// (the app-level constant lives in the cli, not the SDK).
const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

// Shared across tests: NEVER mutate; build a variation as an explicit spread.
// The vault's shape: <2 calldata words, 0 access-list entries, 0 keys> with
// 34-byte schemas. Schema fixtures deliberately end in a non-zero byte (the
// exact-length protocol convention the raw reader relies on).
const SAMPLE_REQUEST: SignBidirectionalEvent = {
  sender: { bytes: bytes(32, 0x01) },
  requestNonce: 7n,
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
        words: [evmAddressAbiWord(bytes(20, 0xee)), numericAbiWordValue(1_000_000n)],
      },
    },
  },
  caip2Id: bytes(32, 0x02),
  outputDeserializationSchema: bytes(34, 0x07),
  respondSerializationSchema: bytes(34, 0x08),
};

// A wider instantiation: <2 words, 1 access-list entry, 2 storage keys> with
// only one key in use — the reader must recover these capacities too.
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

const SAMPLE_REQUEST_ID = bytes(32, 0x2f);
const ACCESS_LIST_REQUEST_ID = bytes(32, 0x31);
const NONCE = 8n;

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
// at field 0 and the request counter at field 1 (this synthetic contract's
// own layout — the reader takes the positions as arguments).
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
  return StateValue.newArray()
    .arrayPush(StateValue.newMap(map))
    .arrayPush(counterCell(NONCE));
};

describe("state-reader (MPC-style raw decode)", () => {
  it("round-trips requests and the nonce through raw state by field position", () => {
    const { nonce, requestsIndex } = readSignetRequestsLedgerFromState(
      syntheticContractState(),
      0,
      1,
    );

    expect(nonce).toBe(NONCE);
    expect(requestsIndex.size).toBe(2);
    expect(requestsIndex.get(requestIdHex(SAMPLE_REQUEST_ID))).toEqual(
      SAMPLE_REQUEST,
    );
    expect(requestsIndex.get(requestIdHex(ACCESS_LIST_REQUEST_ID))).toEqual(
      ACCESS_LIST_REQUEST,
    );
  });

  it("returns an empty index and a zero nonce for a fresh contract", () => {
    const fresh = StateValue.newArray()
      .arrayPush(StateValue.newMap(new StateMap()))
      .arrayPush(counterCell(0n));
    const { nonce, requestsIndex } = readSignetRequestsLedgerFromState(fresh, 0, 1);
    expect(requestsIndex.size).toBe(0);
    expect(nonce).toBe(0n);
  });

  it("reads an index living at a non-zero ledger field", () => {
    // stateWithSecondIndex: index at 0, nonce at 1, a SECOND index at 2.
    const { nonce, requestsIndex } = readSignetRequestsLedgerFromState(
      stateWithSecondIndex(),
      2,
      1,
    );
    expect(nonce).toBe(NONCE);
    expect(requestsIndex.size).toBe(1);
    expect(requestsIndex.get(requestIdHex(FIELD2_REQUEST_ID))).toEqual(
      SAMPLE_REQUEST,
    );
  });

  it("resolves the index behind a List-typed field (array node, like a chunk)", () => {
    // A Compact List field is a fixed THREE-slot cons ARRAY node: the same
    // node type a chunked field root uses. A List declared before the index
    // is exactly the layout that breaks positional guessing, so pin it:
    // list at field 0, nonce at 1, index at 2.
    const listNode = StateValue.newArray()
      .arrayPush(StateValue.newNull())
      .arrayPush(StateValue.newNull())
      .arrayPush(counterCell(0n));
    const state = StateValue.newArray()
      .arrayPush(listNode)
      .arrayPush(counterCell(NONCE))
      .arrayPush(StateValue.newMap(sampleIndexMap()));

    const { nonce, requestsIndex } = readSignetRequestsLedgerFromState(state, 2, 1);
    expect(nonce).toBe(NONCE);
    expect(requestsIndex.get(requestIdHex(SAMPLE_REQUEST_ID))).toEqual(
      SAMPLE_REQUEST,
    );
  });

  it("resolves fields inside a compiler-chunked root (16 fields -> chunks of 1 + 15)", () => {
    // compactc chunks a >15-field contract remainder-FIRST into a
    // depth-uniform tree: 16 fields -> [chunk(1), chunk(15)], so the
    // rightmost chunk is always FULL: the signal that separates a chunk
    // level from an array-typed field such as a List.
    const chunk0 = StateValue.newArray().arrayPush(
      StateValue.newMap(sampleIndexMap()),
    );
    let chunk1 = StateValue.newArray().arrayPush(counterCell(NONCE));
    for (let i = 0; i < 14; i += 1) {
      chunk1 = chunk1.arrayPush(StateValue.newNull());
    }
    const state = StateValue.newArray().arrayPush(chunk0).arrayPush(chunk1);

    // Flat positions: index = field 0 (chunk 0, slot 0), nonce = field 1
    // (chunk 1, slot 0).
    const { nonce, requestsIndex } = readSignetRequestsLedgerFromState(state, 0, 1);
    expect(nonce).toBe(NONCE);
    expect(requestsIndex.get(requestIdHex(SAMPLE_REQUEST_ID))).toEqual(
      SAMPLE_REQUEST,
    );
  });
});

// A second request index living at a NON-ZERO ledger field — so the field
// argument of lookupSignetRequestAt is genuinely exercised, not incidentally
// always 0. Its member is SAMPLE_REQUEST under a distinct id.
const FIELD2_REQUEST_ID = bytes(32, 0x5a);

/** Contract state: index (field 0), nonce (field 1), a SECOND index (field 2). */
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
    requestCell(SAMPLE_REQUEST, CAPACITIES.sample),
  );
  return StateValue.newArray()
    .arrayPush(StateValue.newMap(field0))
    .arrayPush(counterCell(NONCE))
    .arrayPush(StateValue.newMap(field2));
};

describe("lookupSignetRequestAt", () => {
  it("returns the record for a member id at the right field", () => {
    const request = lookupSignetRequestAt(
      stateWithSecondIndex(),
      0,
      requestIdHex(SAMPLE_REQUEST_ID),
    );
    expect(request).toEqual(SAMPLE_REQUEST);
  });

  it("resolves a member of the index at a non-zero field", () => {
    const request = lookupSignetRequestAt(
      stateWithSecondIndex(),
      2,
      requestIdHex(FIELD2_REQUEST_ID),
    );
    expect(request).toEqual(SAMPLE_REQUEST);
  });

  it("returns undefined for a non-member id", () => {
    expect(
      lookupSignetRequestAt(
        stateWithSecondIndex(),
        0,
        requestIdHex(bytes(32, 0x99)),
      ),
    ).toBeUndefined();
  });

  it("returns undefined for a member looked up at the wrong field", () => {
    // SAMPLE_REQUEST_ID lives at field 0, not field 2.
    expect(
      lookupSignetRequestAt(
        stateWithSecondIndex(),
        2,
        requestIdHex(SAMPLE_REQUEST_ID),
      ),
    ).toBeUndefined();
  });

  it("returns undefined when the field is not a Map (e.g. the nonce cell)", () => {
    expect(
      lookupSignetRequestAt(
        stateWithSecondIndex(),
        1,
        requestIdHex(SAMPLE_REQUEST_ID),
      ),
    ).toBeUndefined();
  });

  it("returns undefined when the field index is out of range", () => {
    expect(
      lookupSignetRequestAt(
        stateWithSecondIndex(),
        9,
        requestIdHex(SAMPLE_REQUEST_ID),
      ),
    ).toBeUndefined();
  });

  it("agrees byte-for-byte with readSignetRequestsLedgerFromState (reader parity)", () => {
    const raw = stateWithSecondIndex();
    const viaReader = readSignetRequestsLedgerFromState(raw, 0, 1).requestsIndex.get(
      requestIdHex(SAMPLE_REQUEST_ID),
    );
    expect(lookupSignetRequestAt(raw, 0, requestIdHex(SAMPLE_REQUEST_ID))).toEqual(
      viaReader,
    );
  });
});
