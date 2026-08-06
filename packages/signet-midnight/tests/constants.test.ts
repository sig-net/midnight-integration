// Unit tests for the padded-ASCII codec and the MPC failure sentinel.

import { describe, expect, it } from "vitest";

import {
  asciiPadded,
  isMpcFailureOutput,
  MPC_FAILURE_OUTPUT,
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

// The failure output is a wire constant shared by the responder and every
// client's refund circuit: pin its exact bytes.
describe("MPC_FAILURE_OUTPUT", () => {
  it("is the 4-byte error marker followed by a single 0x01 byte", () => {
    expect(MPC_FAILURE_OUTPUT).toEqual(
      Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x01]),
    );
  });
});

/** One row of the serializedOutput decode table: bytes → expected verdict. */
interface DecodeCase {
  /** Test name, completing the sentence "decodes <name>". */
  name: string;
  /** The response's serialized output. */
  serializedOutput: Uint8Array;
  /** Expected {@link isMpcFailureOutput} verdict. */
  failure: boolean;
}

// Outputs are the exact unpadded respond payloads (a packed bool is one
// byte). Only exact byte equality with the 5-byte failure payload counts as
// the MPC failure: prefixes and extensions are legitimate packed outputs.
const DECODE_CASES: DecodeCase[] = [
  {
    name: "a one-byte packed bool (0x01)",
    serializedOutput: Uint8Array.from([1]),
    failure: false,
  },
  {
    name: "a one-byte packed bool (0x00)",
    serializedOutput: Uint8Array.from([0]),
    failure: false,
  },
  {
    name: "the exact 5-byte failure payload",
    serializedOutput: MPC_FAILURE_OUTPUT,
    failure: true,
  },
  {
    name: "a 4-byte deadbeef prefix with a different fifth byte",
    serializedOutput: Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x02]),
    failure: false,
  },
  {
    name: "the bare 4-byte deadbeef marker without the 0x01 byte",
    serializedOutput: Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
    failure: false,
  },
  {
    name: "a 6-byte output that merely starts with the failure payload",
    serializedOutput: Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]),
    failure: false,
  },
];

describe("isMpcFailureOutput", () => {
  it.each(DECODE_CASES)("decodes $name", ({ serializedOutput, failure }) => {
    expect(isMpcFailureOutput(serializedOutput)).toBe(failure);
  });
});
