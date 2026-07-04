// Round-trip test for the MPC-style raw state reader: encode a request with
// the canonical descriptors into a synthetic StateValue tree (the shape the
// indexer returns for a contract address), then decode it back by field
// position alone — no compiled contract involved.

import { describe, expect, it } from "vitest";

import { StateMap, StateValue } from "@midnight-ntwrk/compact-runtime";

import {
  readSignetEVMSignatureRequestIndexFromState,
  requestIdHex,
  requestIdType,
  signetEVMSignatureRequestType,
  type SignetEVMSignatureRequest,
} from "../src/index.ts";

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

const sampleRequest: SignetEVMSignatureRequest = {
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

const requestId = bytes(32, 0x2f);

// Contract root state: an array of ledger fields with the request index map
// at field 0 — the signet layout convention.
const syntheticContractState = () => {
  const map = new StateMap().insert(
    {
      value: requestIdType.toValue(requestId),
      alignment: requestIdType.alignment(),
    },
    StateValue.newCell({
      value: signetEVMSignatureRequestType.toValue(sampleRequest),
      alignment: signetEVMSignatureRequestType.alignment(),
    }),
  );
  return StateValue.newArray().arrayPush(StateValue.newMap(map));
};

describe("state-reader (MPC-style raw decode)", () => {
  it("round-trips a request through raw state by field position", () => {
    const index = readSignetEVMSignatureRequestIndexFromState(
      syntheticContractState(),
    );

    expect(index.size).toBe(1);
    const decoded = index.get(requestIdHex(requestId));
    expect(decoded).toEqual(sampleRequest);
  });

  it("returns an empty index for an empty map", () => {
    const empty = StateValue.newArray().arrayPush(
      StateValue.newMap(new StateMap()),
    );
    expect(readSignetEVMSignatureRequestIndexFromState(empty).size).toBe(0);
  });
});
