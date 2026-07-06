// Round-trip test for the MPC-/client-style signature-responses reader: encode
// a counter index and a response log with the canonical descriptors into a
// synthetic StateValue tree (the shape the indexer returns for the responses
// contract), then decode them back by field position alone — no compiled
// contract involved. Mirrors signature-requests-state-reader.test.ts.

import { describe, expect, it } from "vitest";

import {
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  StateMap,
  StateValue,
} from "@midnight-ntwrk/compact-runtime";

import {
  readSignetResponsesLedgerFromState,
  requestIdHex,
  requestIdType,
  signatureResponseIndexKey,
  signatureResponseKeyType,
} from "../src/index.ts";

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

const u64 = new CompactTypeUnsignedInteger(18446744073709551615n, 8);
const bytes65 = new CompactTypeBytes(65);

const REQUEST_ID = bytes(32, 0x2f);
// Two responses posted for REQUEST_ID: counter reads 2, entries at counts 0..1.
const POST_COUNT = 2n;
const RESPONSE_0 = bytes(65, 0xa0);
const RESPONSE_1 = bytes(65, 0xa1);

/** Counter cell as the runtime stores it: a u64 in a plain cell. */
const counterCell = (value: bigint) =>
  StateValue.newCell({ value: u64.toValue(value), alignment: u64.alignment() });

const responseCell = (response: Uint8Array) =>
  StateValue.newCell({
    value: bytes65.toValue(response),
    alignment: bytes65.alignment(),
  });

const responseKey = (count: bigint) => ({
  value: signatureResponseKeyType.toValue({ count, requestId: REQUEST_ID }),
  alignment: signatureResponseKeyType.alignment(),
});

// Contract root state: an array of ledger fields with the counter index map at
// field 0 and the response log map at field 1 — the signet response layout
// convention.
const syntheticContractState = () => {
  const counterMap = new StateMap().insert(
    {
      value: requestIdType.toValue(REQUEST_ID),
      alignment: requestIdType.alignment(),
    },
    counterCell(POST_COUNT),
  );
  const responseMap = new StateMap()
    .insert(responseKey(0n), responseCell(RESPONSE_0))
    .insert(responseKey(1n), responseCell(RESPONSE_1));
  return StateValue.newArray()
    .arrayPush(StateValue.newMap(counterMap))
    .arrayPush(StateValue.newMap(responseMap));
};

describe("signature-responses-state-reader (MPC-style raw decode)", () => {
  it("round-trips the counter index and response log through raw state by field position", () => {
    const { signatureResponseCounterIndex, signatureResponseIndex } =
      readSignetResponsesLedgerFromState(syntheticContractState());

    expect(signatureResponseCounterIndex.size).toBe(1);
    expect(signatureResponseCounterIndex.get(requestIdHex(REQUEST_ID))).toBe(
      POST_COUNT,
    );

    expect(signatureResponseIndex.size).toBe(2);
    expect(
      signatureResponseIndex.get(signatureResponseIndexKey(requestIdHex(REQUEST_ID), 0n)),
    ).toEqual(RESPONSE_0);
    expect(
      signatureResponseIndex.get(signatureResponseIndexKey(requestIdHex(REQUEST_ID), 1n)),
    ).toEqual(RESPONSE_1);
  });

  it("returns empty indexes for a fresh responses contract", () => {
    const fresh = StateValue.newArray()
      .arrayPush(StateValue.newMap(new StateMap()))
      .arrayPush(StateValue.newMap(new StateMap()));
    const { signatureResponseCounterIndex, signatureResponseIndex } =
      readSignetResponsesLedgerFromState(fresh);
    expect(signatureResponseCounterIndex.size).toBe(0);
    expect(signatureResponseIndex.size).toBe(0);
  });
});
