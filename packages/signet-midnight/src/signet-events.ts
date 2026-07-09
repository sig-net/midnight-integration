// Off-chain codecs for the event notifications the central signet contract
// emits (Signet.compact structs wrapped in stdlib `Misc { name, payload }`
// events — see packages/xcontract-events/knowledge-base/events.md), one per
// direction of the MPC round trip:
//   - SignBidirectionalEvent: the MPC watches these to discover WHEN a
//     request was stored and WHERE to read it. Attribution is re-established
//     by reading the request from the named caller's own authenticated ledger
//     (see signet-request-resolver.ts and
//     knowledge-base/caller-attribution.md); a field inside the event is not
//     trustworthy (a Midnight contract cannot see its caller — gotcha #21).
//   - SignatureRespondedEvent: the requesting client watches these to learn a
//     signature response was posted, then reads the post back from the
//     response log and verifies the signature off-chain (the log is
//     unauthenticated — see signet-response-feed.ts).
// Either way the event is a notification only — never the source of truth.
//
// These are the event-side twins of the Compact structs — each MUST stay in
// lockstep with its struct in Signet.compact (field order and widths). The
// byte layouts are pinned by the golden e2e tests against a live indexer.

import { bytesToHex, requestIdHex, type RequestIdHex } from "./signet-requests.ts";

/**
 * The `Misc` event `name` tag the signet contract emits alongside the
 * serialized {@link SignBidirectionalEvent} payload (Compact:
 * `pad(32, "SignBidirectionalEvent")`). Observers filter on this ascii tag.
 */
export const SIGN_BIDIRECTIONAL_EVENT_TAG = "SignBidirectionalEvent";

/** Byte width of the `callerAddress` field (Compact `ContractAddress` = 32 raw bytes). */
const CALLER_ADDRESS_BYTES = 32;

/** Byte width of the `requestId` field (Compact `Bytes<32>`). */
const REQUEST_ID_BYTES = 32;

/**
 * Minimum serialized length: `callerAddress` (32) + `requestId` (32) +
 * `signBidirectionalRequestsIndexField` (1). `serialize<T,256>` right-pads to
 * 256, so a real payload is longer; this is the floor the decoder needs.
 */
const MIN_PAYLOAD_BYTES = CALLER_ADDRESS_BYTES + REQUEST_ID_BYTES + 1;

/**
 * TS twin of the Compact `SignBidirectionalEvent` *event* struct (not the
 * request record). The notification the signet contract emits so the MPC knows
 * a {@link SignBidirectionalRequest} was stored — and, crucially, WHERE to read
 * the authenticated copy of it.
 */
export interface SignBidirectionalEvent {
  /**
   * Address of the contract whose request index holds the request (Compact
   * `ContractAddress`, rendered as lowercase hex, no `0x` prefix — directly
   * usable as a `queryContractState` argument). The MPC reads the request from
   * THIS contract's authenticated state; the event field itself confers no
   * authority.
   */
  callerAddress: string;
  /** Which request in {@link callerAddress}'s index this notification is about. */
  requestId: RequestIdHex;
  /**
   * Ledger field position of the `Map<RequestId, SignBidirectionalRequest>`
   * request index in {@link callerAddress} (the signet layout convention puts
   * it at field 0, but the event carries it so the reader never assumes).
   */
  requestsIndexField: number;
}

/**
 * Strip an optional `0x`/`0X` prefix from a hex string.
 *
 * @param hex - A hex string, with or without a `0x` prefix.
 * @returns The bare hex digits.
 */
export function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/**
 * Decode a hex string (as the indexer returns `Misc.name` / `Misc.payload`)
 * into bytes.
 *
 * @param hex - Hex digits, with or without a `0x` prefix.
 * @returns The decoded bytes.
 */
export function hexToBytes(hex: string): Uint8Array {
  const digits = stripHexPrefix(hex);
  const out = new Uint8Array(digits.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(digits.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

/**
 * The ascii tag of a zero-padded `Bytes<N>` name (the Compact `pad(N, "text")`
 * convention): decode the hex, then trim the trailing NUL padding.
 *
 * @param nameHex - The indexer's hex-encoded `Misc.name`.
 * @returns The trimmed ascii tag, e.g. `"SignBidirectionalEvent"`.
 */
export function eventNameTag(nameHex: string): string {
  return new TextDecoder().decode(hexToBytes(nameHex)).replace(/\0+$/, "");
}

/**
 * Decode a `Misc` payload (`serialize<SignBidirectionalEvent, 256>`) into the
 * struct. `serialize<T,N>` lays fields out in declaration order, packed at the
 * front and right-zero-padded to N (see knowledge-base/events.md): a
 * `ContractAddress` is 32 raw bytes, so
 * `callerAddress = payload[0..32]`, `requestId = payload[32..64]`,
 * `requestsIndexField = payload[64]`.
 *
 * The byte layout is pinned against a live indexer by the golden e2e test —
 * `callerAddress` is the struct's FIRST field, a different position than the
 * DepositEvent precedent's `caller`, so do not assume it without that test.
 *
 * @param payload - The decoded (raw bytes) `Misc.payload`.
 * @returns The decoded event notification.
 * @throws Error if the payload is shorter than the fixed fields require.
 */
export function decodeSignBidirectionalEvent(
  payload: Uint8Array,
): SignBidirectionalEvent {
  if (payload.length < MIN_PAYLOAD_BYTES) {
    throw new Error(
      `SignBidirectionalEvent payload is ${payload.length} bytes — fewer than ` +
        `the ${MIN_PAYLOAD_BYTES} its fixed fields need`,
    );
  }
  const callerAddress = bytesToHex(payload.slice(0, CALLER_ADDRESS_BYTES));
  const requestId = requestIdHex(
    payload.slice(CALLER_ADDRESS_BYTES, CALLER_ADDRESS_BYTES + REQUEST_ID_BYTES),
  );
  const requestsIndexField = payload[CALLER_ADDRESS_BYTES + REQUEST_ID_BYTES];
  return { callerAddress, requestId, requestsIndexField };
}

/**
 * The `Misc` event `name` tag the signet contract emits alongside the
 * serialized {@link SignatureRespondedEvent} payload (Compact:
 * `pad(32, "SignatureRespondedEvent")`). Observers filter on this ascii tag.
 */
export const SIGNATURE_RESPONDED_EVENT_TAG = "SignatureRespondedEvent";

/** Byte width of the `count` field (Compact `Uint<64>` = 8 bytes, little-endian). */
const COUNT_BYTES = 8;

/**
 * Minimum serialized length of a {@link SignatureRespondedEvent}: `requestId`
 * (32) + `count` (8). `serialize<T,256>` right-pads to 256, so a real payload
 * is longer; this is the floor the decoder needs.
 */
const MIN_RESPONDED_PAYLOAD_BYTES = REQUEST_ID_BYTES + COUNT_BYTES;

/**
 * TS twin of the Compact `SignatureRespondedEvent` *event* struct (not the
 * {@link SignatureResponse} record it announces). The notification the signet
 * contract emits from `postSignatureResponse` so the requesting client knows
 * a response post landed — and WHERE in the response log to read it back.
 * A ping only: the log is unauthenticated, so the client must verify the
 * post's signature off-chain (see signet-response-feed.ts).
 */
export interface SignatureRespondedEvent {
  /** Which request the posted response answers. */
  requestId: RequestIdHex;
  /**
   * 0-based position of the post in {@link requestId}'s response log — the
   * `count` half of the `SignetResponseKey` it is stored under.
   */
  count: bigint;
}

/**
 * Decode a `Misc` payload (`serialize<SignatureRespondedEvent, 256>`) into
 * the struct. Layout per knowledge-base/events.md: fields in declaration
 * order packed at the front — `requestId = payload[0..32]` (raw bytes),
 * `count = payload[32..40]` (Uint<64>, LITTLE-endian) — right-zero-padded.
 *
 * @param payload - The decoded (raw bytes) `Misc.payload`.
 * @returns The decoded event notification.
 * @throws Error if the payload is shorter than the fixed fields require.
 */
export function decodeSignatureRespondedEvent(
  payload: Uint8Array,
): SignatureRespondedEvent {
  if (payload.length < MIN_RESPONDED_PAYLOAD_BYTES) {
    throw new Error(
      `SignatureRespondedEvent payload is ${payload.length} bytes — fewer than ` +
        `the ${MIN_RESPONDED_PAYLOAD_BYTES} its fixed fields need`,
    );
  }
  const requestId = requestIdHex(payload.slice(0, REQUEST_ID_BYTES));
  let count = 0n;
  for (let i = REQUEST_ID_BYTES + COUNT_BYTES - 1; i >= REQUEST_ID_BYTES; i--) {
    count = (count << 8n) | BigInt(payload[i]);
  }
  return { requestId, count };
}

/**
 * One signet event kind as an observer consumes it: the `Misc.name` ascii tag
 * to filter on plus the payload decoder. A `SignetEventObserver` is
 * instantiated with one of these — see {@link signBidirectionalEventCodec}
 * and {@link signatureRespondedEventCodec}.
 */
export interface SignetMiscEventCodec<T> {
  /** The ascii `Misc.name` tag identifying this event kind. */
  readonly tag: string;
  /**
   * Decode a raw `Misc.payload` into the typed notification.
   *
   * @param payload - The decoded (raw bytes) `Misc.payload`.
   * @returns The decoded event notification.
   * @throws Error if the payload is malformed.
   */
  decode(payload: Uint8Array): T;
}

/** The {@link SignetMiscEventCodec} of {@link SignBidirectionalEvent} notifications. */
export const signBidirectionalEventCodec: SignetMiscEventCodec<SignBidirectionalEvent> =
  {
    tag: SIGN_BIDIRECTIONAL_EVENT_TAG,
    decode: decodeSignBidirectionalEvent,
  };

/** The {@link SignetMiscEventCodec} of {@link SignatureRespondedEvent} notifications. */
export const signatureRespondedEventCodec: SignetMiscEventCodec<SignatureRespondedEvent> =
  {
    tag: SIGNATURE_RESPONDED_EVENT_TAG,
    decode: decodeSignatureRespondedEvent,
  };
