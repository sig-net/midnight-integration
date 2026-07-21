// Unit tests for the compiled Signet pure circuits (see
// src/circuits.compact). These exercise the REAL compiled circuit logic
// in-process via pureCircuits — no ledger, no network, no proving.
//
// Only the compiled-circuit surface is tested here: the generic request
// circuits cannot be compiled into it — request construction is exercised
// through each requester contract's simulator tests, and the request-id TS
// twin is checked against the real compiled contract in caller-contract's
// submit round-trip test. The attestation digest / verify circuits have
// their own suite (ecdsa-attestation.test.ts).

import { describe, expect, it } from "vitest";

import { pureCircuits, decodeSignBidirectionalNotification, bytesToHex } from "../src/index.ts";

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

describe("constructSignBidirectionalEventNotificationV1 (compiled packer)", () => {
  const CALLER = { bytes: bytes(32, 0xc1) };

  it("packs the V1 layout: callerAddress (32) ++ requestsIndexField (1) ++ zero padding (95)", () => {
    const notification = pureCircuits.constructSignBidirectionalEventNotificationV1(
      CALLER,
      4n,
    );
    expect(notification.version).toBe(1n);
    expect(notification.payload).toHaveLength(128);
    expect(notification.payload.slice(0, 32)).toEqual(CALLER.bytes);
    expect(notification.payload[32]).toBe(4);
    expect(notification.payload.slice(33)).toEqual(new Uint8Array(95));
  });

  it("round-trips through the decoder (pack↔decode lockstep)", () => {
    const notification = pureCircuits.constructSignBidirectionalEventNotificationV1(
      CALLER,
      7n,
    );
    expect(decodeSignBidirectionalNotification(notification)).toEqual({
      version: 1,
      callerAddress: bytesToHex(CALLER.bytes),
      requestsIndexField: 7,
    });
  });
});
