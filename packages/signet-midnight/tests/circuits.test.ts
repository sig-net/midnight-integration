// Unit tests for the compiled Signet pure circuits (see
// src/circuits.compact). These exercise the REAL compiled circuit logic
// in-process via pureCircuits — no ledger, no network, no proving.
//
// Only the compiled-circuit surface is tested here: the generic request
// circuits cannot be compiled into it — request construction is exercised
// through each requester contract's simulator tests, and the request-id TS
// twin is checked against the real compiled contract in vault-contract's
// deposit round-trip test (see contract.test.ts).

import { describe, expect, it } from "vitest";

import { pureCircuits, bytesToHex } from "../src/index.ts";

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
const COMMITMENT_HEX = bytesToHex(COMMITMENT); // "5a" * 32
const PATH = asciiPadded(COMMITMENT_HEX, 256);

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

describe("Signet compiled circuits", () => {
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

  it("assertPathCommitment accepts the canonical zero-padded path", () => {
    expect(() =>
      pureCircuits.assertPathCommitment(COMMITMENT, PATH),
    ).not.toThrow();
  });

  it("assertPathCommitment rejects non-zero bytes after the hex", () => {
    const dirty = new Uint8Array(PATH);
    dirty[200] = 0x41;
    expect(() => pureCircuits.assertPathCommitment(COMMITMENT, dirty)).toThrow(
      /zero-padded/,
    );
  });
});
