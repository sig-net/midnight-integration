// Unit tests for the compiled Signet pure circuits (see
// src/circuits.compact). These exercise the REAL compiled circuit logic
// in-process via pureCircuits — no ledger, no network, no proving.
//
// Only the compiled-circuit surface is tested here: the generic request
// circuits cannot be compiled into it — request construction is exercised
// through each requester contract's simulator tests, and the request-id TS
// twin is checked against the real compiled contract in test-caller-contract's
// submit round-trip test. The attestation digest / verify circuits have
// their own suite (ecdsa-attestation.test.ts).

import { describe, expect, it } from "vitest";

import {
  abiWordToBool,
  abiWordToUint128,
  asciiPadded,
  boolAbiWord,
  bytesToHex,
  decodeSignBidirectionalNotification,
  evmAddressAbiWord,
  EXECUTION_DEST_BYTES,
  hexToBytes,
  numericAbiWord,
  pureCircuits,
} from "../src/index.ts";

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

describe("constructSignBidirectionalEventNotificationV1 (compiled packer)", () => {
  const CALLER = { bytes: bytes(32, 0xc1) };

  it("packs the V1 layout: callerAddress (32) ++ depth (1) ++ path (4) ++ zero padding (91)", () => {
    // A flat contract's field 4: path [4] at depth 1.
    const notification = pureCircuits.constructSignBidirectionalEventNotificationV1(CALLER, 1n, [
      4n,
      0n,
      0n,
      0n,
    ]);
    expect(notification.version).toBe(1n);
    expect(notification.payload).toHaveLength(128);
    expect(notification.payload.slice(0, 32)).toEqual(CALLER.bytes);
    expect(notification.payload[32]).toBe(1); // depth
    expect(notification.payload.slice(33, 37)).toEqual(Uint8Array.from([4, 0, 0, 0]));
    expect(notification.payload.slice(37)).toEqual(new Uint8Array(91));
  });

  it("packs a chunked contract's depth-2 path and the decoder trims to depth", () => {
    // A contract past 15 fields whose map compactc stored at chunk [1, 14].
    const notification = pureCircuits.constructSignBidirectionalEventNotificationV1(CALLER, 2n, [
      1n,
      14n,
      0n,
      0n,
    ]);
    expect(notification.payload[32]).toBe(2); // depth
    expect(notification.payload.slice(33, 37)).toEqual(Uint8Array.from([1, 14, 0, 0]));
    expect(decodeSignBidirectionalNotification(notification).requestsPath).toEqual([1, 14]);
  });

  it("round-trips through the decoder (pack↔decode lockstep)", () => {
    const notification = pureCircuits.constructSignBidirectionalEventNotificationV1(CALLER, 1n, [
      7n,
      0n,
      0n,
      0n,
    ]);
    expect(decodeSignBidirectionalNotification(notification)).toEqual({
      version: 1,
      callerAddress: bytesToHex(CALLER.bytes),
      requestsPath: [7],
    });
  });
});

describe("ethereumCaip2Id (MPC routing key)", () => {
  it("is eip155:1 zero-padded to the executionDest width", () => {
    // Lockstep with Chain::Ethereum.caip2_chain_id() in sig-net/mpc
    // signet-primitives/src/chain.rs: the MPC rejects any other value.
    expect(pureCircuits.ethereumCaip2Id()).toEqual(asciiPadded("eip155:1", EXECUTION_DEST_BYTES));
  });
});

describe("ABI word circuits (circuit/TS lockstep, golden bytes)", () => {
  // Each row pins BOTH the compiled circuit and its TS twin to fixed
  // big-endian bytes, so a compiler change that altered the circuit's cast
  // could not pass by the twin merely agreeing with it. Values sit on the
  // byte, 64-bit and 128-bit boundaries where an endianness slip shows.
  const NUMERIC_WORD_VECTORS: { value: bigint; word: string }[] = [
    { value: 0n, word: "0000000000000000000000000000000000000000000000000000000000000000" },
    { value: 1n, word: "0000000000000000000000000000000000000000000000000000000000000001" },
    { value: 255n, word: "00000000000000000000000000000000000000000000000000000000000000ff" },
    { value: 256n, word: "0000000000000000000000000000000000000000000000000000000000000100" },
    { value: 1_000_000n, word: "00000000000000000000000000000000000000000000000000000000000f4240" },
    {
      value: (1n << 64n) - 1n,
      word: "000000000000000000000000000000000000000000000000ffffffffffffffff",
    },
    {
      value: 1n << 64n,
      word: "0000000000000000000000000000000000000000000000010000000000000000",
    },
    {
      value: (1n << 64n) + 1n,
      word: "0000000000000000000000000000000000000000000000010000000000000001",
    },
    {
      value: (1n << 128n) - 1n,
      word: "00000000000000000000000000000000ffffffffffffffffffffffffffffffff",
    },
  ];

  it.each(NUMERIC_WORD_VECTORS)(
    "numericAbiWord($value): circuit and TS twin both emit $word",
    ({ value, word }) => {
      expect(bytesToHex(pureCircuits.numericAbiWord(value))).toBe(word);
      expect(bytesToHex(numericAbiWord(value))).toBe(word);
    },
  );

  it.each(NUMERIC_WORD_VECTORS)(
    "abiWordToUint128($word) reads back $value, circuit and TS",
    ({ value, word }) => {
      expect(pureCircuits.abiWordToUint128(hexToBytes(word))).toBe(value);
      expect(abiWordToUint128(hexToBytes(word))).toBe(value);
    },
  );

  it("abiWordToUint128 rejects a word wider than Uint<128>", () => {
    const wide = hexToBytes("0000000000000000000000000000000100000000000000000000000000000000");
    expect(() => pureCircuits.abiWordToUint128(wide)).toThrow();
    expect(() => abiWordToUint128(wide)).toThrow("exceeds Uint<128>");
  });

  it("evmAddressAbiWord: 12 zero bytes, then the display-order address, circuit and TS", () => {
    const address = hexToBytes("a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3");
    const word = "000000000000000000000000a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3";
    expect(bytesToHex(pureCircuits.evmAddressAbiWord(address))).toBe(word);
    expect(bytesToHex(evmAddressAbiWord(address))).toBe(word);
  });

  const BOOL_WORD_VECTORS: { value: boolean; word: string }[] = [
    { value: false, word: "0000000000000000000000000000000000000000000000000000000000000000" },
    { value: true, word: "0000000000000000000000000000000000000000000000000000000000000001" },
  ];

  it.each(BOOL_WORD_VECTORS)(
    "boolAbiWord($value): circuit and TS twin both emit $word",
    ({ value, word }) => {
      expect(bytesToHex(pureCircuits.boolAbiWord(value))).toBe(word);
      expect(bytesToHex(boolAbiWord(value))).toBe(word);
    },
  );

  it.each(BOOL_WORD_VECTORS)(
    "abiWordToBool($word) reads back $value, circuit and TS",
    ({ value, word }) => {
      expect(pureCircuits.abiWordToBool(hexToBytes(word))).toBe(value);
      expect(abiWordToBool(hexToBytes(word))).toBe(value);
    },
  );

  it.each([
    {
      reason: "nonzero byte in the zero prefix",
      word: "0100000000000000000000000000000000000000000000000000000000000000",
    },
    {
      reason: "last byte outside 0/1",
      word: "0000000000000000000000000000000000000000000000000000000000000002",
    },
  ])("abiWordToBool rejects $reason, circuit and TS", ({ word }) => {
    expect(() => pureCircuits.abiWordToBool(hexToBytes(word))).toThrow();
    expect(() => abiWordToBool(hexToBytes(word))).toThrow("canonical Boolean");
  });
});
