// Codec tests for the signet event notifications. Per gotcha #5, an emitted
// event is NOT observable in the in-process simulator, so these decode
// CONSTRUCTED payload byte fixtures laid out exactly as `serialize<T, 256>`
// documents (declaration order, each field its natural width — Uints
// little-endian — packed at the front, right-zero-padded to 256). The live
// golden e2e tests pin the same layouts against a real indexer and capture
// real payloads to replace these fixtures if a layout ever drifts.

import { describe, expect, it } from "vitest";

import {
  SIGN_BIDIRECTIONAL_EVENT_TAG,
  SIGNATURE_RESPONDED_EVENT_TAG,
  decodeSignBidirectionalEvent,
  decodeSignatureRespondedEvent,
  eventNameTag,
  hexToBytes,
  requestIdHex,
  bytesToHex,
  asciiPadded,
} from "../src/index.ts";

// An intentionally ASYMMETRIC caller address (0x01,0x02,…,0x20): a byte-reversal
// bug would surface as 20…01 instead of 0102…20.
const CALLER_ADDRESS_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const CALLER_ADDRESS_HEX = bytesToHex(CALLER_ADDRESS_BYTES);
// A distinct, also-asymmetric request id.
const REQUEST_ID_BYTES = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i);
const REQUEST_ID_HEX = requestIdHex(REQUEST_ID_BYTES);
const REQUESTS_INDEX_FIELD = 0;

/** Build a `serialize<SignBidirectionalEvent, 256>` payload from its parts. */
const buildPayload = (
  caller: Uint8Array,
  requestId: Uint8Array,
  field: number,
): Uint8Array => {
  const payload = new Uint8Array(256);
  payload.set(caller, 0);
  payload.set(requestId, 32);
  payload[64] = field;
  return payload;
};

describe("decodeSignBidirectionalEvent", () => {
  it("recovers callerAddress, requestId, and requestsIndexField exactly", () => {
    const decoded = decodeSignBidirectionalEvent(
      buildPayload(CALLER_ADDRESS_BYTES, REQUEST_ID_BYTES, REQUESTS_INDEX_FIELD),
    );
    expect(decoded.callerAddress).toBe(CALLER_ADDRESS_HEX);
    expect(decoded.requestId).toBe(REQUEST_ID_HEX);
    expect(decoded.requestsIndexField).toBe(REQUESTS_INDEX_FIELD);
  });

  it("decodes callerAddress without byte-reversal", () => {
    const decoded = decodeSignBidirectionalEvent(
      buildPayload(CALLER_ADDRESS_BYTES, REQUEST_ID_BYTES, 0),
    );
    // First byte 0x01 → hex begins "0102…", not the reversed "…0201".
    expect(decoded.callerAddress.startsWith("0102")).toBe(true);
    expect(decoded.callerAddress.endsWith("1f20")).toBe(true);
  });

  it("reads a non-zero requestsIndexField", () => {
    const decoded = decodeSignBidirectionalEvent(
      buildPayload(CALLER_ADDRESS_BYTES, REQUEST_ID_BYTES, 3),
    );
    expect(decoded.requestsIndexField).toBe(3);
  });

  it("rejects a payload shorter than the fixed fields", () => {
    expect(() => decodeSignBidirectionalEvent(new Uint8Array(64))).toThrow(
      /fewer than/,
    );
  });
});

/** Build a `serialize<SignatureRespondedEvent, 256>` payload from its parts. */
const buildRespondedPayload = (
  requestId: Uint8Array,
  count: bigint,
): Uint8Array => {
  const payload = new Uint8Array(256);
  payload.set(requestId, 0);
  let value = count;
  for (let i = 0; i < 8; i++) {
    payload[32 + i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return payload;
};

describe("decodeSignatureRespondedEvent", () => {
  it("recovers requestId and count exactly", () => {
    const decoded = decodeSignatureRespondedEvent(
      buildRespondedPayload(REQUEST_ID_BYTES, 7n),
    );
    expect(decoded.requestId).toBe(REQUEST_ID_HEX);
    expect(decoded.count).toBe(7n);
  });

  it("decodes a multi-byte count as LITTLE-endian", () => {
    // 0x0102 LE = bytes [0x02, 0x01, 0, …]; a big-endian misread would give
    // 0x0201000000000000 instead.
    const decoded = decodeSignatureRespondedEvent(
      buildRespondedPayload(REQUEST_ID_BYTES, 0x0102n),
    );
    expect(decoded.count).toBe(258n);
  });

  it("decodes count 0 (the first post for a request)", () => {
    const decoded = decodeSignatureRespondedEvent(
      buildRespondedPayload(REQUEST_ID_BYTES, 0n),
    );
    expect(decoded.count).toBe(0n);
  });

  it("rejects a payload shorter than the fixed fields", () => {
    expect(() => decodeSignatureRespondedEvent(new Uint8Array(39))).toThrow(
      /fewer than/,
    );
  });

  it("carries a tag distinct from the request-side event", () => {
    expect(SIGNATURE_RESPONDED_EVENT_TAG).not.toBe(SIGN_BIDIRECTIONAL_EVENT_TAG);
  });
});

describe("eventNameTag", () => {
  it("NUL-trims a zero-padded Bytes<32> tag to its ascii", () => {
    const nameHex = bytesToHex(asciiPadded(SIGN_BIDIRECTIONAL_EVENT_TAG, 32));
    expect(eventNameTag(nameHex)).toBe(SIGN_BIDIRECTIONAL_EVENT_TAG);
  });

  it("tolerates a 0x prefix on the hex name", () => {
    const nameHex = `0x${bytesToHex(asciiPadded("deposit", 32))}`;
    expect(eventNameTag(nameHex)).toBe("deposit");
  });
});

describe("hexToBytes", () => {
  it("round-trips through bytesToHex, prefix-insensitive", () => {
    const bytes = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
    expect(hexToBytes(`0x${bytesToHex(bytes)}`)).toEqual(bytes);
  });
});
