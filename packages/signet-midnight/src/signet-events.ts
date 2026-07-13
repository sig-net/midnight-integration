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
//   - RespondBidirectionalEvent: the requesting client watches these to learn
//     the MPC's attestation of a request's remote execution landed, then reads
//     the record back from the respond-bidirectional index — no off-chain
//     verification, the contract authenticated it in-circuit at post time.
// In every case the event is a notification only — never the source of truth.
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

/**
 * Byte width of the leading `version` tag (Compact `Uint<8>`). The event is a
 * FROZEN `{ version, payload }` envelope (see `SignBidirectionalEvent` in
 * Signet.compact): `version` is at offset 0 and every V1 field is shifted one
 * byte to make room for it.
 */
const VERSION_BYTES = 1;

/** The only payload interpretation this decoder understands today. */
const SUPPORTED_VERSION = 1;

/** Byte width of the `callerAddress` field (Compact `ContractAddress` = 32 raw bytes). */
const CALLER_ADDRESS_BYTES = 32;

/** Byte width of the `requestId` field (Compact `Bytes<32>`). */
const REQUEST_ID_BYTES = 32;

/** Offset of the V1 `callerAddress` in the outer payload (after the version byte). */
const CALLER_ADDRESS_OFFSET = VERSION_BYTES;

/** Offset of the V1 `requestId` (after version + callerAddress). */
const REQUEST_ID_OFFSET = CALLER_ADDRESS_OFFSET + CALLER_ADDRESS_BYTES;

/** Offset of the V1 `signBidirectionalRequestsIndexField` (after version + caller + requestId). */
const REQUESTS_INDEX_FIELD_OFFSET = REQUEST_ID_OFFSET + REQUEST_ID_BYTES;

/**
 * Minimum serialized length of a V1 event: `version` (1) + `callerAddress` (32)
 * + `requestId` (32) + `signBidirectionalRequestsIndexField` (1) = 66.
 * `serialize<T,256>` right-pads to 256, so a real payload is longer; this is the
 * floor the decoder needs.
 */
const MIN_PAYLOAD_BYTES = REQUESTS_INDEX_FIELD_OFFSET + 1;

/**
 * TS twin of the Compact `SignBidirectionalEvent` *event* struct (not the
 * request record). The notification the signet contract emits so the MPC knows
 * a {@link SignBidirectionalRequest} was stored — and, crucially, WHERE to read
 * the authenticated copy of it.
 */
export interface SignBidirectionalEvent {
  /**
   * The frozen envelope's `version` tag (Compact `Uint<8>`). Selects how the
   * opaque payload was interpreted; this decoder only understands version 1.
   */
  version: number;
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
 * struct. The event is a frozen `{ version: Uint<8>, payload: Bytes<224> }`
 * envelope, and V1 packs the concrete fields into that inner payload with
 * `serialize<SignBidirectionalEventV1Payload, 224>`. `serialize<T,N>` lays
 * fields out in declaration order, packed at the front and right-zero-padded
 * (see knowledge-base/events.md), so in the outer 256-byte payload:
 * `version = payload[0]`, then everything shifts one byte —
 * `callerAddress = payload[1..33]`, `requestId = payload[33..65]`,
 * `requestsIndexField = payload[65]`.
 *
 * The byte layout is pinned against a live indexer by the golden e2e test —
 * `callerAddress` is the V1 payload's FIRST field, a different position than the
 * DepositEvent precedent's `caller`, so do not assume it without that test.
 *
 * Fails closed on an unrecognised `version`: a future payload layout adds a
 * branch here (and, off-chain, a V{N} decoder) rather than silently
 * misinterpreting bytes under the V1 offsets.
 *
 * @param payload - The decoded (raw bytes) `Misc.payload`.
 * @returns The decoded event notification.
 * @throws Error if the payload is shorter than the fixed fields require, or its
 *   `version` is not one this decoder understands.
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
  const version = payload[0];
  if (version !== SUPPORTED_VERSION) {
    throw new Error(
      `SignBidirectionalEvent version ${version} is not supported ` +
        `(this decoder understands version ${SUPPORTED_VERSION})`,
    );
  }
  const callerAddress = bytesToHex(
    payload.slice(CALLER_ADDRESS_OFFSET, CALLER_ADDRESS_OFFSET + CALLER_ADDRESS_BYTES),
  );
  const requestId = requestIdHex(
    payload.slice(REQUEST_ID_OFFSET, REQUEST_ID_OFFSET + REQUEST_ID_BYTES),
  );
  const requestsIndexField = payload[REQUESTS_INDEX_FIELD_OFFSET];
  return { version, callerAddress, requestId, requestsIndexField };
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
 * The `Misc` event `name` tag the signet contract emits alongside the
 * serialized {@link RespondBidirectionalEvent} payload (Compact:
 * `pad(32, "RespondBidirectionalEvent")`). Observers filter on this ascii tag.
 */
export const RESPOND_BIDIRECTIONAL_EVENT_TAG = "RespondBidirectionalEvent";

/**
 * Minimum serialized length of a {@link RespondBidirectionalEvent}:
 * `requestId` (32). `serialize<T,256>` right-pads to 256, so a real payload
 * is longer; this is the floor the decoder needs.
 */
const MIN_RESPOND_BIDIRECTIONAL_PAYLOAD_BYTES = REQUEST_ID_BYTES;

/**
 * TS twin of the Compact `RespondBidirectionalEvent` *event* struct (not the
 * `RespondBidirectional` record it announces). The notification the signet
 * contract emits from `postRespondBidirectional` when the MPC's attestation
 * of a request's remote execution lands in the respond-bidirectional index —
 * at most once per request (one authenticated slot, first valid write wins).
 * A ping only, but unlike {@link SignatureRespondedEvent} no off-chain
 * verification follows the read-back: the contract verified the attestation
 * in-circuit at post time, so the stored record is authentic by construction.
 */
export interface RespondBidirectionalEvent {
  /** Which request the stored attestation answers. */
  requestId: RequestIdHex;
}

/**
 * Decode a `Misc` payload (`serialize<RespondBidirectionalEvent, 256>`) into
 * the struct. Layout per knowledge-base/events.md: fields in declaration
 * order packed at the front — `requestId = payload[0..32]` (raw bytes) —
 * right-zero-padded.
 *
 * @param payload - The decoded (raw bytes) `Misc.payload`.
 * @returns The decoded event notification.
 * @throws Error if the payload is shorter than the fixed fields require.
 */
export function decodeRespondBidirectionalEvent(
  payload: Uint8Array,
): RespondBidirectionalEvent {
  if (payload.length < MIN_RESPOND_BIDIRECTIONAL_PAYLOAD_BYTES) {
    throw new Error(
      `RespondBidirectionalEvent payload is ${payload.length} bytes — fewer than ` +
        `the ${MIN_RESPOND_BIDIRECTIONAL_PAYLOAD_BYTES} its fixed fields need`,
    );
  }
  return { requestId: requestIdHex(payload.slice(0, REQUEST_ID_BYTES)) };
}

/**
 * One signet event kind as an observer consumes it: the `Misc.name` ascii tag
 * to filter on plus the payload decoder. A `SignetEventObserver` is
 * instantiated with one of these — see {@link signBidirectionalEventCodec},
 * {@link signatureRespondedEventCodec}, and
 * {@link respondBidirectionalEventCodec}.
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

/** The {@link SignetMiscEventCodec} of {@link RespondBidirectionalEvent} notifications. */
export const respondBidirectionalEventCodec: SignetMiscEventCodec<RespondBidirectionalEvent> =
  {
    tag: RESPOND_BIDIRECTIONAL_EVENT_TAG,
    decode: decodeRespondBidirectionalEvent,
  };
