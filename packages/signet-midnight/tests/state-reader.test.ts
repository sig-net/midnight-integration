// Round-trip test for the MPC-style raw state reader: encode a request with
// the canonical descriptors into a synthetic StateValue tree (the shape the
// indexer returns for a contract address), then decode it back by field
// position alone — no compiled contract involved.

import { describe, expect, it } from "vitest";

import { CompactTypeUnsignedInteger, StateMap, StateValue } from "@midnight-ntwrk/compact-runtime";

import {
  readSignetRequestsLedgerFromState,
  requestIdHex,
  requestIdType,
  signetEVMSignatureRequestType,
  type SignetEVMSignatureRequest,
} from "../src/index.ts";

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

// Shared across tests: NEVER mutate; build a variation as an explicit spread.
const SAMPLE_REQUEST: SignetEVMSignatureRequest = {
  requestNonce: 7n,
  evmTransaction: {
    to: bytes(20, 0xaa),
    chainId: 11155111n,
    nonce: 3n,
    gasLimit: 100000n,
    maxFeePerGas: 30000000000n,
    maxPriorityFeePerGas: 2000000000n,
    value: 0n,
  },
  calldata: {
    funcSig: bytes(256, 0x01),
    argCount: 2n,
    args: [bytes(32, 1), bytes(32, 2), bytes(32, 0), bytes(32, 0)],
  },
  mpcRouting: {
    caip2Id: bytes(64, 0x02),
    keyVersion: 0n,
    path: bytes(256, 0x03),
    algo: bytes(32, 0x04),
    dest: bytes(64, 0x05),
    params: bytes(512, 0x06),
    outputSchema: bytes(256, 0x07),
    respondSchema: bytes(256, 0x08),
  },
};

const REQUEST_ID = bytes(32, 0x2f);
const NONCE = 8n;

const u64 = new CompactTypeUnsignedInteger(18446744073709551615n, 8);

/** Counter cell as the runtime stores it: a u64 in a plain cell. */
const counterCell = (value: bigint) =>
  StateValue.newCell({ value: u64.toValue(value), alignment: u64.alignment() });

// Contract root state: an array of ledger fields with the request index map
// at field 0 and the request counter at field 1 — the signet layout
// convention.
const syntheticContractState = () => {
  const map = new StateMap().insert(
    {
      value: requestIdType.toValue(REQUEST_ID),
      alignment: requestIdType.alignment(),
    },
    StateValue.newCell({
      value: signetEVMSignatureRequestType.toValue(SAMPLE_REQUEST),
      alignment: signetEVMSignatureRequestType.alignment(),
    }),
  );
  return StateValue.newArray()
    .arrayPush(StateValue.newMap(map))
    .arrayPush(counterCell(NONCE));
};

describe("state-reader (MPC-style raw decode)", () => {
  it("round-trips a request and the nonce through raw state by field position", () => {
    const { nonce, requestsIndex } = readSignetRequestsLedgerFromState(
      syntheticContractState(),
    );

    expect(nonce).toBe(NONCE);
    expect(requestsIndex.size).toBe(1);
    const decoded = requestsIndex.get(requestIdHex(REQUEST_ID));
    expect(decoded).toEqual(SAMPLE_REQUEST);
  });

  it("returns an empty index and a zero nonce for a fresh contract", () => {
    const fresh = StateValue.newArray()
      .arrayPush(StateValue.newMap(new StateMap()))
      .arrayPush(counterCell(0n));
    const { nonce, requestsIndex } = readSignetRequestsLedgerFromState(fresh);
    expect(requestsIndex.size).toBe(0);
    expect(nonce).toBe(0n);
  });
});
