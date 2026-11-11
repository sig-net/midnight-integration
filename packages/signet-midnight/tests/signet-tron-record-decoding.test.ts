// Raw-cell decoding of a stored Tron request record: encode records with the
// canonical descriptor at several capacities, decode them back alone and
// through the raw state reader, and pin each refusal. The compiled
// contract's own cell is decoded in tron-golden.test.ts.

import { type AlignedValue, StateMap, StateValue } from "@midnight-ntwrk/compact-runtime";
import { describe, expect, it } from "vitest";

import {
  calculateRequestId,
  decodeTronSignBidirectionalEvent,
  lookupSignetRequestAt,
  MPCDestination,
  MPCSignatureAlgorithm,
  pureCircuits,
  readSignetRequestsLedgerFromState,
  requestIdHex,
  type SignBidirectionalEvent,
  tronSignBidirectionalEventDescriptor,
  type TronTxParams,
  TxParamType,
} from "../src/index.ts";
// Package-internal descriptor, imported from its defining module.
import { requestIdType } from "../src/signet-requests.ts";

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

/** Known-good Tron record at calldata capacity 2: the base every test uses. NEVER mutate. */
const TRON_REQUEST: SignBidirectionalEvent<TronTxParams> = {
  keyVersion: 1n,
  sender: { bytes: bytes(32, 0x01) },
  path: bytes(32, 0x03),
  algo: MPCSignatureAlgorithm.ecdsa,
  txParamType: TxParamType.tron,
  txParams: {
    refBlockBytes: Uint8Array.from([0x27, 0x10]),
    refBlockHash: bytes(8, 0x42),
    timestamp: 1_728_000_000_000n,
    expiration: 1_728_000_060_000n,
    feeLimit: 50_000_000n,
    contractAddress: Uint8Array.from([0x41, ...bytes(20, 0xcd)]),
    callValue: 0n,
    calldata: {
      is_some: true,
      value: {
        selector: Uint8Array.from([0xa9, 0x05, 0x9c, 0xbb]),
        noWords: 1n,
        words: [bytes(32, 0x11), bytes(32, 0)],
      },
    },
  },
  executionDest: pureCircuits.tronCaip2Id(),
  signatureDest: MPCDestination.unused,
  params: bytes(64, 0),
  outputDeserializationSchema: new Uint8Array(0),
  respondSerializationSchema: new Uint8Array(0),
};

/** Encode `request` as a stored cell at its own capacity and schema widths. */
const cellOf = (request: SignBidirectionalEvent<TronTxParams>): AlignedValue => {
  const descriptor = tronSignBidirectionalEventDescriptor(
    request.txParams.calldata.value.words.length,
    request.outputDeserializationSchema.length,
    request.respondSerializationSchema.length,
  );
  return { value: descriptor.toValue(request), alignment: descriptor.alignment() };
};

describe("decodeTronSignBidirectionalEvent", () => {
  it.each([
    { name: "capacity 2", request: TRON_REQUEST },
    {
      name: "capacity 0 with an absent calldata",
      request: {
        ...TRON_REQUEST,
        txParams: {
          ...TRON_REQUEST.txParams,
          calldata: {
            is_some: false,
            value: { selector: bytes(4, 0), noWords: 0n, words: [] },
          },
        },
      },
    },
    {
      name: "capacity 3 with 34-byte schemas",
      request: {
        ...TRON_REQUEST,
        txParams: {
          ...TRON_REQUEST.txParams,
          calldata: {
            is_some: true,
            value: {
              selector: bytes(4, 0xab),
              noWords: 3n,
              words: [bytes(32, 0x11), bytes(32, 0x12), bytes(32, 0x13)],
            },
          },
        },
        outputDeserializationSchema: bytes(34, 0x07),
        respondSerializationSchema: bytes(34, 0x08),
      },
    },
  ])("decodes a record at $name back to itself", ({ request }) => {
    expect(decodeTronSignBidirectionalEvent(cellOf(request), "test record")).toEqual(request);
  });

  it("rejects a cell with fewer than the fixed field count of atoms", () => {
    const { value, alignment } = cellOf(TRON_REQUEST);
    expect(() =>
      decodeTronSignBidirectionalEvent(
        { value: value.slice(0, 19), alignment: alignment.slice(0, 19) },
        "test record",
      ),
    ).toThrow(/has 19 value atoms, fewer than the 20 its fixed fields need/);
  });

  it("rejects a calldata-word region holding an atom of another width", () => {
    const { value, alignment } = cellOf(TRON_REQUEST);
    expect(() =>
      decodeTronSignBidirectionalEvent(
        {
          value,
          // Atom 16 is the second word slot: narrow it away from 32 bytes.
          alignment: alignment.map((segment, i) =>
            i === 16 ? { tag: "atom", value: { tag: "bytes", length: 31 } } : segment,
          ),
        },
        "test record",
      ),
    ).toThrow(/calldata-word region holds a non-Bytes<32> atom/);
  });
});

describe("raw state reading of a Tron record", () => {
  const REQUEST_ID = calculateRequestId(TRON_REQUEST);

  /** Root state: a request index holding TRON_REQUEST under `key`. */
  const stateWith = (key: Uint8Array): StateValue =>
    StateValue.newArray().arrayPush(
      StateValue.newMap(
        new StateMap().insert(
          { value: requestIdType.toValue(key), alignment: requestIdType.alignment() },
          StateValue.newCell(cellOf(TRON_REQUEST)),
        ),
      ),
    );

  it("readSignetRequestsLedgerFromState decodes the record", () => {
    const { requestsIndex } = readSignetRequestsLedgerFromState(stateWith(REQUEST_ID), [0]);
    expect(requestsIndex.get(requestIdHex(REQUEST_ID))).toEqual(TRON_REQUEST);
  });

  it("lookupSignetRequestAt returns the record filed under its own id", () => {
    expect(lookupSignetRequestAt(stateWith(REQUEST_ID), [0], requestIdHex(REQUEST_ID))).toEqual(
      TRON_REQUEST,
    );
  });

  it("lookupSignetRequestAt drops a record filed under another id", () => {
    const wrongKey = bytes(32, 0x99);
    expect(lookupSignetRequestAt(stateWith(wrongKey), [0], requestIdHex(wrongKey))).toBeUndefined();
  });
});
