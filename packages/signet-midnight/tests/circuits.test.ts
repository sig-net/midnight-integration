// Unit tests for the compiled SignetRequests pure circuits (see
// src/circuits.compact). These exercise the REAL compiled circuit logic
// in-process via pureCircuits — no ledger, no network, no proving.
//
// The explicit twin-type annotations double as compile-time tripwires: if the
// hand-written types in signet-requests.ts ever drift from the Compact
// structs, this file stops typechecking.

import { describe, expect, it } from "vitest";

import {
  pureCircuits,
  requestIdHex,
  type SignetEVMSignatureRequest,
  type SignetEVMSignatureRequestParams,
  type EVMCalldata,
} from "../src/index.ts";

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

/** Zero-padded ASCII bytes, the Compact `pad(N, "text")` convention. */
const asciiPadded = (text: string, length: number): Uint8Array => {
  const out = new Uint8Array(length);
  out.set(new TextEncoder().encode(text));
  return out;
};

// A commitment and its canonical path: lowercase hex, zero-padded to 256.
const commitment = bytes(32, 0x5a);
const commitmentHex = requestIdHex(commitment); // "5a" * 32
const path = asciiPadded(commitmentHex, 256);

const requestParams: SignetEVMSignatureRequestParams = {
  evmTransaction: {
    to: bytes(20, 0xaa),
    chainId: 11155111n,
    nonce: 3n,
    gasLimit: 100000n,
    maxFeePerGas: 30000000000n,
    maxPriorityFeePerGas: 2000000000n,
    value: 0n,
  },
  mpcRouting: {
    caip2Id: asciiPadded("eip155:11155111", 64),
    keyVersion: 0n,
    path,
    algo: asciiPadded("ecdsa", 32),
    dest: asciiPadded("ethereum", 64),
    params: bytes(512, 0),
    outputSchema: bytes(256, 0x07),
    respondSchema: bytes(256, 0x08),
  },
};

const calldata: EVMCalldata = {
  funcSig: asciiPadded("transfer(address,uint256)", 256),
  argCount: 2n,
  args: [bytes(32, 1), bytes(32, 2), bytes(32, 0), bytes(32, 0)],
};

describe("SignetRequests compiled circuits", () => {
  it("assertHexOf accepts the canonical lowercase hex of a commitment", () => {
    expect(() =>
      pureCircuits.assertHexOf(commitment, asciiPadded(commitmentHex, 64)),
    ).not.toThrow();
  });

  it("assertHexOf rejects non-canonical (uppercase) hex", () => {
    const uppercase = asciiPadded(commitmentHex.toUpperCase(), 64);
    expect(() => pureCircuits.assertHexOf(commitment, uppercase)).toThrow(
      /non-canonical hex char/,
    );
  });

  it("assertHexOf rejects hex of a different commitment", () => {
    expect(() =>
      pureCircuits.assertHexOf(bytes(32, 0x11), asciiPadded(commitmentHex, 64)),
    ).toThrow(/does not match commitment/);
  });

  it("assertPathCommitment rejects non-zero bytes after the hex", () => {
    const dirty = new Uint8Array(path);
    dirty[200] = 0x41;
    expect(() => pureCircuits.assertPathCommitment(commitment, dirty)).toThrow(
      /zero-padded/,
    );
  });

  it("constructSignetEVMSignatureRequest assembles the record when the path binds", () => {
    // Twin-type tripwire: params/result typed via the hand-written twins.
    const request: SignetEVMSignatureRequest =
      pureCircuits.constructSignetEVMSignatureRequest(
        commitment,
        1n,
        requestParams,
        calldata,
      );

    expect(request).toEqual({
      requestNonce: 1n,
      evmTransaction: requestParams.evmTransaction,
      calldata,
      mpcRouting: requestParams.mpcRouting,
    });
  });

  it("constructSignetEVMSignatureRequest refuses a foreign commitment", () => {
    expect(() =>
      pureCircuits.constructSignetEVMSignatureRequest(
        bytes(32, 0x11), // not the commitment the path encodes
        1n,
        requestParams,
        calldata,
      ),
    ).toThrow(/does not match commitment/);
  });

  it("request ids are deterministic, 32 bytes, and field-sensitive", () => {
    const request = pureCircuits.constructSignetEVMSignatureRequest(
      commitment,
      1n,
      requestParams,
      calldata,
    );

    const id = pureCircuits.signetEVMSignatureRequestId(request);
    expect(id).toHaveLength(32);
    expect(pureCircuits.signetEVMSignatureRequestId(request)).toEqual(id);

    const bumpedNonce: SignetEVMSignatureRequest = {
      ...request,
      requestNonce: 2n,
    };
    expect(pureCircuits.signetEVMSignatureRequestId(bumpedNonce)).not.toEqual(
      id,
    );
  });
});
