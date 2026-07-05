// Unit tests for the padded-ASCII codec and the byte conversion helpers.

import { describe, expect, it } from "vitest";

import { asciiPadded, bigintToBytes32, bytesToBigint } from "../src/index.ts";

describe("asciiPadded", () => {
  interface Case {
    name: string;
    text: string;
    length: number;
    expectedPrefix: number[];
  }

  const CASES: Case[] = [
    { name: "algo value", text: "ecdsa", length: 32, expectedPrefix: [0x65, 0x63, 0x64, 0x73, 0x61, 0, 0] },
    { name: "empty text", text: "", length: 4, expectedPrefix: [0, 0, 0, 0] },
    { name: "exact fit", text: "ab", length: 2, expectedPrefix: [0x61, 0x62] },
  ];

  it.each(CASES)("$name: zero-padded to the field width", ({ text, length, expectedPrefix }) => {
    const encoded = asciiPadded(text, length);
    expect(encoded.length).toBe(length);
    expect([...encoded.slice(0, expectedPrefix.length)]).toEqual(expectedPrefix);
    expect(encoded.slice(text.length).every((byte) => byte === 0)).toBe(true);
  });

  it("rejects text longer than the field", () => {
    expect(() => asciiPadded("too long", 4)).toThrow(/does not fit/);
  });
});

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
