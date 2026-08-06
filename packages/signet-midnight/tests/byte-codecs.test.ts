// Unit tests for the little-endian Compact-cast byte codecs.

import { describe, expect, it } from "vitest";

import { bigintToBytes32, bytesToBigint } from "../src/index.ts";

describe("bigintToBytes32 / bytesToBigint", () => {
  interface Case {
    name: string;
    value: bigint;
  }

  const CASES: Case[] = [
    { name: "zero", value: 0n },
    { name: "one (little-endian: first byte)", value: 1n },
    { name: "usdc amount", value: 100000n },
    { name: "large value", value: 2n ** 200n + 12345n },
  ];

  it.each(CASES)("$name round-trips", ({ value }) => {
    const bytes = bigintToBytes32(value);
    expect(bytes.length).toBe(32);
    expect(bytesToBigint(bytes)).toBe(value);
  });

  it("is little-endian (Compact Field as Bytes<32>)", () => {
    expect(bigintToBytes32(1n)[0]).toBe(1);
    expect(bigintToBytes32(256n)[1]).toBe(1);
  });
});
