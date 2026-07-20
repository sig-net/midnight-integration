// Unit tests for the padded-ASCII codec, the byte conversion helpers, and the
// serialized-output execution verdicts.

import { describe, expect, it } from "vitest";

import {
  asciiPadded,
  bigintToBytes32,
  bytesToBigint,
  executionSucceeded,
  isExecutionError,
  MPC_ERROR_SENTINEL,
} from "../src/index.ts";

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

describe("serializedOutput decoding", () => {
  interface Case {
    /** Test name, completing the sentence "decodes <name>". */
    name: string;
    /** The attestation's serialized output. */
    serializedOutput: Uint8Array;
    /** Expected {@link executionSucceeded} verdict. */
    succeeded: boolean;
    /** Expected {@link isExecutionError} verdict. */
    error: boolean;
  }

  const CASES: Case[] = [
    {
      name: "a success flag (first byte 1)",
      serializedOutput: (() => { const out = new Uint8Array(128); out[0] = 1; return out; })(),
      succeeded: true,
      error: false,
    },
    {
      name: "a false return (all zero)",
      serializedOutput: new Uint8Array(128),
      succeeded: false,
      error: false,
    },
    {
      name: "the MPC error sentinel (0xdeadbeef prefix)",
      serializedOutput: (() => {
        const out = new Uint8Array(128);
        out.set(MPC_ERROR_SENTINEL);
        return out;
      })(),
      succeeded: false,
      error: true,
    },
  ];

  it.each(CASES)("decodes $name", ({ serializedOutput, succeeded, error }) => {
    expect(executionSucceeded(serializedOutput)).toBe(succeeded);
    expect(isExecutionError(serializedOutput)).toBe(error);
  });
});
