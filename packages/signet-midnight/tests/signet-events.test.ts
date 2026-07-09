// Codec test for the SignBidirectionalEvent notification. Per gotcha #5, an
// emitted event is NOT observable in the in-process simulator, so this decodes
// a CONSTRUCTED payload byte fixture laid out exactly as
// `serialize<SignBidirectionalEvent, 256>` documents (declaration order, each
// field its natural width, packed at the front, right-zero-padded to 256). The
// live golden e2e test pins the same layout against a real indexer and captures
// a real payload to replace this fixture if the layout ever drifts.

import { describe, expect, it } from "vitest";

import {
  SIGN_BIDIRECTIONAL_EVENT_TAG,
  decodeSignBidirectionalEvent,
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
