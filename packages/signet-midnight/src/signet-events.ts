// Off-chain codec for the SignBidirectionalEvent notification the central
// signet contract emits (Signet.compact `struct SignBidirectionalEvent`,
// wrapped in a stdlib `Misc { name, payload }` event — see
// packages/xcontract-events/knowledge-base/events.md). The MPC watches the
// signet contract's `Misc` events to discover WHEN a request was stored and
// WHERE to read it; the event is a notification only — never the source of
// truth. Attribution is re-established by reading the request from the named
// caller's own authenticated ledger (see signet-request-resolver.ts and
// knowledge-base/caller-attribution.md); a field inside the event is not
// trustworthy (a Midnight contract cannot see its caller — gotcha #21).
//
// This is the event-side twin of the Compact struct — it MUST stay in lockstep
// with `SignBidirectionalEvent` in Signet.compact (field order and widths). The
// byte layout is pinned by the golden e2e test against a live indexer.

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
