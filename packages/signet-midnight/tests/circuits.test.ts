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
  boolAbiWord,
  bytesToHex,
  decodeSignBidirectionalNotification,
  evmAddressAbiWord,
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

describe("ABI word circuits (circuit/TS lockstep)", () => {
  const ADDRESS = Uint8Array.from({ length: 20 }, (_, i) => 0xa0 + i);
  const VALUES = [0n, 1n, 255n, 256n, 1_000_000n, (1n << 128n) - 1n];

  it("evmAddressAbiWord: circuit and TS mirror emit identical bytes", () => {
    const circuitWord = pureCircuits.evmAddressAbiWord(ADDRESS);
    expect(circuitWord).toHaveLength(32);
    expect(circuitWord).toEqual(evmAddressAbiWord(ADDRESS));
    // Broadcast form: 12 zero bytes, then the display-order address.
    expect(circuitWord.slice(0, 12)).toEqual(new Uint8Array(12));
    expect(circuitWord.slice(12)).toEqual(ADDRESS);
  });

  it("numericAbiWord: circuit and TS mirror emit identical bytes", () => {
    for (const value of VALUES) {
      const circuitWord = pureCircuits.numericAbiWord(value);
      expect(circuitWord).toEqual(numericAbiWord(value));
    }
  });

  it("abiWordToUint128 round-trips numericAbiWord, circuit and TS", () => {
    for (const value of VALUES) {
      const word = pureCircuits.numericAbiWord(value);
      expect(pureCircuits.abiWordToUint128(word)).toBe(value);
      expect(abiWordToUint128(word)).toBe(value);
    }
  });

  it("abiWordToUint128 rejects a word wider than Uint<128>", () => {
    const wide = new Uint8Array(32);
    wide[15] = 1; // lowest byte of the forbidden high half
    expect(() => pureCircuits.abiWordToUint128(wide)).toThrow();
    expect(() => abiWordToUint128(wide)).toThrow("exceeds Uint<128>");
  });

  it("boolAbiWord: circuit and TS mirror emit identical bytes", () => {
    for (const value of [true, false]) {
      const circuitWord = pureCircuits.boolAbiWord(value);
      expect(circuitWord).toHaveLength(32);
      expect(circuitWord).toEqual(boolAbiWord(value));
    }
    expect(pureCircuits.boolAbiWord(false)).toEqual(new Uint8Array(32));
    expect(pureCircuits.boolAbiWord(true)[31]).toBe(1);
  });

  it("abiWordToBool round-trips boolAbiWord, circuit and TS", () => {
    for (const value of [true, false]) {
      const word = pureCircuits.boolAbiWord(value);
      expect(pureCircuits.abiWordToBool(word)).toBe(value);
      expect(abiWordToBool(word)).toBe(value);
    }
  });

  it("abiWordToBool rejects non-canonical words", () => {
    const junkHigh = new Uint8Array(32);
    junkHigh[0] = 1; // nonzero byte in the zero prefix
    const junkLast = new Uint8Array(32);
    junkLast[31] = 2; // last byte outside 0/1
    for (const word of [junkHigh, junkLast]) {
      expect(() => pureCircuits.abiWordToBool(word)).toThrow();
      expect(() => abiWordToBool(word)).toThrow("canonical Boolean");
    }
  });
});
