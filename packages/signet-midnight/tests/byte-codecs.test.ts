// Unit tests for the little-endian and big-endian fixed-width byte codecs.

import { describe, expect, it } from "vitest";

import {
  BLS_ORDER,
  bigintToBytes32,
  bigintToBytes32BE,
  bytesToBigint,
  bytesToBigintBE,
} from "../src/index.ts";

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

  it("interprets negative values in the BLS scalar field", () => {
    expect(bytesToBigint(bigintToBytes32(-1n))).toBe(BLS_ORDER - 1n);
  });
});

describe("bigintToBytes32BE / bytesToBigintBE", () => {
  interface Case {
    name: string;
    value: bigint;
  }

  const CASES: Case[] = [
    { name: "zero", value: 0n },
    { name: "one (big-endian: last byte)", value: 1n },
    { name: "usdc amount", value: 100000n },
    { name: "large value", value: 2n ** 200n + 12345n },
    { name: "max 256-bit value", value: (1n << 256n) - 1n },
  ];

  it.each(CASES)("$name round-trips", ({ value }) => {
    const bytes = bigintToBytes32BE(value);
    expect(bytes.length).toBe(32);
    expect(bytesToBigintBE(bytes)).toBe(value);
  });

  it("is big-endian (SEC1 signature and ABI word order)", () => {
    expect(bigintToBytes32BE(1n)[31]).toBe(1);
    expect(bigintToBytes32BE(256n)[30]).toBe(1);
  });

  it.each([
    { name: "a negative value", value: -1n },
    { name: "2^256, one past the width", value: 1n << 256n },
  ])("rejects $name", ({ value }) => {
    expect(() => bigintToBytes32BE(value)).toThrow(
      /does not fit 32 big-endian bytes/,
    );
  });
});
