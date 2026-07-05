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
// Shared across tests: NEVER mutate; build a variation as a fresh copy.
const COMMITMENT = bytes(32, 0x5a);
const COMMITMENT_HEX = requestIdHex(COMMITMENT); // "5a" * 32
const PATH = asciiPadded(COMMITMENT_HEX, 256);

/**
 * Known-good request params bound to {@link COMMITMENT}'s path.
 * Shared across tests: NEVER mutate; build a variation as an explicit spread.
 */
const REQUEST_PARAMS: SignetEVMSignatureRequestParams = {
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
    path: PATH,
    algo: asciiPadded("ecdsa", 32),
    dest: asciiPadded("ethereum", 64),
    params: bytes(512, 0),
    outputSchema: bytes(256, 0x07),
    respondSchema: bytes(256, 0x08),
  },
};

/** Sample calldata record. Shared across tests: NEVER mutate. */
const CALLDATA: EVMCalldata = {
  funcSig: asciiPadded("transfer(address,uint256)", 256),
  argCount: 2n,
  args: [bytes(32, 1), bytes(32, 2), bytes(32, 0), bytes(32, 0)],
};

/** One row of the assertHexOf table: full inputs → accepted or expected error. */
interface AssertHexOfCase {
  /** Test name, completing the sentence "assertHexOf <name>". */
  name: string;
  /** 32-byte commitment the hex is checked against. */
  commitment: Uint8Array;
  /** 64-byte candidate hex encoding. */
  hex: Uint8Array;
  /** Error the circuit must throw, or null when it must accept. */
  throws: RegExp | null;
}

const ASSERT_HEX_OF_CASES: AssertHexOfCase[] = [
  {
    name: "accepts the canonical lowercase hex of a commitment",
    commitment: COMMITMENT,
    hex: asciiPadded(COMMITMENT_HEX, 64),
    throws: null,
  },
  {
    name: "rejects non-canonical (uppercase) hex",
    commitment: COMMITMENT,
    hex: asciiPadded(COMMITMENT_HEX.toUpperCase(), 64),
    throws: /non-canonical hex char/,
  },
  {
    name: "rejects hex of a different commitment",
    commitment: bytes(32, 0x11),
    hex: asciiPadded(COMMITMENT_HEX, 64),
    throws: /does not match commitment/,
  },
];

describe("SignetRequests compiled circuits", () => {
  it.each(ASSERT_HEX_OF_CASES)(
    "assertHexOf $name",
    ({ commitment, hex, throws }) => {
      const call = () => pureCircuits.assertHexOf(commitment, hex);
      if (throws === null) {
        expect(call).not.toThrow();
      } else {
        expect(call).toThrow(throws);
      }
    },
  );

  it("assertPathCommitment rejects non-zero bytes after the hex", () => {
    const dirty = new Uint8Array(PATH);
    dirty[200] = 0x41;
    expect(() => pureCircuits.assertPathCommitment(COMMITMENT, dirty)).toThrow(
      /zero-padded/,
    );
  });

  it("constructSignetEVMSignatureRequest assembles the record when the path binds", () => {
    // Twin-type tripwire: params/result typed via the hand-written twins.
    const request: SignetEVMSignatureRequest =
      pureCircuits.constructSignetEVMSignatureRequest(
        COMMITMENT,
        1n,
        REQUEST_PARAMS,
        CALLDATA,
      );

    expect(request).toEqual({
      requestNonce: 1n,
      evmTransaction: REQUEST_PARAMS.evmTransaction,
      calldata: CALLDATA,
      mpcRouting: REQUEST_PARAMS.mpcRouting,
    });
  });

  it("constructSignetEVMSignatureRequest refuses a foreign commitment", () => {
    expect(() =>
      pureCircuits.constructSignetEVMSignatureRequest(
        bytes(32, 0x11), // not the commitment the path encodes
        1n,
        REQUEST_PARAMS,
        CALLDATA,
      ),
    ).toThrow(/does not match commitment/);
  });

  it("request ids are deterministic, 32 bytes, and field-sensitive", () => {
    const request = pureCircuits.constructSignetEVMSignatureRequest(
      COMMITMENT,
      1n,
      REQUEST_PARAMS,
      CALLDATA,
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
