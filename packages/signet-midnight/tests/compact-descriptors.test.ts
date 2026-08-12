// Unit tests for the whole-value decode entry point of the descriptor
// toolkit. The descriptors themselves are exercised through the reader and
// request tests that compose them.

import { describe, expect, it } from "vitest";

import { BYTES_32, decodeExactly, UINT_64 } from "../src/compact-descriptors.ts";

describe("decodeExactly", () => {
  it("round-trips a whole value through its descriptor", () => {
    expect(decodeExactly(UINT_64, UINT_64.toValue(7n), "counter")).toBe(7n);
  });

  it("re-pads the trailing zeros the state layer trims", () => {
    const stored = new Uint8Array(32).fill(0xab);
    stored[31] = 0;
    // toValue trims the zero tail, as the ledger stores atoms.
    const atoms = BYTES_32.toValue(stored);
    expect(atoms[0]).toHaveLength(31);
    expect(decodeExactly(BYTES_32, atoms, "id")).toEqual(stored);
  });

  it("rejects leftover atoms instead of decoding a prefix", () => {
    const atoms = [...UINT_64.toValue(7n), ...UINT_64.toValue(8n)];
    expect(() => decodeExactly(UINT_64, atoms, "counter")).toThrow(
      "counter decode left 1 of 2 atoms unconsumed",
    );
  });

  it("never mutates the input atoms", () => {
    const atoms = UINT_64.toValue(7n);
    decodeExactly(UINT_64, atoms, "counter");
    expect(atoms).toHaveLength(1);
  });
});
