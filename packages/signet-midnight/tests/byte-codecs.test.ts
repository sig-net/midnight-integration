// Unit tests for the byte codecs: hex strings and the little-endian and
// big-endian fixed-width integer encodings.

import { maxField } from "@midnight-ntwrk/compact-runtime";
import { describe, expect, it } from "vitest";

import {
  bigintToBytes32,
  bigintToBytes32BE,
  BLS_ORDER,
  bytesToBigint,
  bytesToBigintBE,
  bytesToHex,
  hexToBytes,
  stripHexPrefix,
} from "../src/index.ts";

// Pin the hardcoded field order to the runtime's own authority.
describe("BLS_ORDER", () => {
  it("is compact-runtime's maxField() + 1", () => {
    expect(BLS_ORDER).toBe(maxField() + 1n);
  });
});

describe("bytesToHex / hexToBytes", () => {
  /** One accept row: hex input and the bytes it decodes to. */
  interface HexAcceptCase {
    name: string;
    hex: string;
    bytes: number[];
  }

  const ACCEPT_CASES: HexAcceptCase[] = [
    { name: "lowercase digits", hex: "ab01ff", bytes: [0xab, 0x01, 0xff] },
    { name: "uppercase digits", hex: "AB01FF", bytes: [0xab, 0x01, 0xff] },
    { name: "a 0x prefix", hex: "0xab01", bytes: [0xab, 0x01] },
    { name: "a 0X prefix", hex: "0Xab01", bytes: [0xab, 0x01] },
    { name: "the empty string", hex: "", bytes: [] },
  ];

  it.each(ACCEPT_CASES)("decodes $name", ({ hex, bytes }) => {
    expect([...hexToBytes(hex)]).toEqual(bytes);
  });

  it.each([
    { name: "an odd number of digits", hex: "abc" },
    { name: "non-hex characters", hex: "zz" },
    { name: "a partial hex pair", hex: "1g" },
    { name: "a bare 0x prefix on odd digits", hex: "0xabc" },
  ])("rejects $name", ({ hex }) => {
    expect(() => hexToBytes(hex)).toThrow(/not a hex byte string/);
  });

  it("bytesToHex renders lowercase unprefixed pairs", () => {
    expect(bytesToHex(Uint8Array.from([0x00, 0xab, 0xff]))).toBe("00abff");
  });

  it("round-trips bytes -> hex -> bytes as identity", () => {
    const raw = Uint8Array.from({ length: 40 }, (_, i) => (i * 37) % 256);
    expect(hexToBytes(bytesToHex(raw))).toEqual(raw);
  });
});

describe("stripHexPrefix", () => {
  it.each([
    { name: "a 0x prefix", input: "0xabc1", expected: "abc1" },
    { name: "a 0X prefix", input: "0Xabc1", expected: "abc1" },
    { name: "no prefix", input: "abc1", expected: "abc1" },
    { name: "the empty string", input: "", expected: "" },
  ])("strips $name", ({ input, expected }) => {
    expect(stripHexPrefix(input)).toBe(expected);
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

  it("interprets negative values in the BLS scalar field", () => {
    expect(bytesToBigint(bigintToBytes32(-1n))).toBe(BLS_ORDER - 1n);
    expect(bytesToBigint(bigintToBytes32(-BLS_ORDER))).toBe(0n);
  });

  it("encodes the full raw 32-byte range above the field order", () => {
    expect(bytesToBigint(bigintToBytes32((1n << 256n) - 1n))).toBe((1n << 256n) - 1n);
  });

  it.each([
    { name: "2^256, one past the width", value: 1n << 256n },
    { name: "a value below -BLS_ORDER", value: -BLS_ORDER - 1n },
  ])("rejects $name", ({ value }) => {
    expect(() => bigintToBytes32(value)).toThrow(/does not fit 32 little-endian bytes/);
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
    expect(() => bigintToBytes32BE(value)).toThrow(/does not fit 32 big-endian bytes/);
  });
});
