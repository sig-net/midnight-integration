// Test-local ENCODE twins of the signet contract's emit literals: build the
// SignetMiscEvent shapes the feed/reader tests serve through stub event
// sources. Encode-side only and test-only on purpose: the decode side lives
// in src/signet-contract-events.ts, and its lockstep against the REAL
// contract emits is pinned by the signet-contract package's simulator tests
// (which run the actual circuits and decode their events). A drift in these
// fixtures shows up there, not here.

import {
  SIGNET_EVENT_PAYLOAD_LENGTH,
  SignetEventName,
  type RespondBidirectionalEvent,
  type SignatureRespondedEvent,
  type SignBidirectionalNotificationRecord,
  type SignetMiscEvent,
} from "../src/index.ts";

/**
 * Concatenate payload parts and zero-pad to the full signet event payload
 * width, mirroring the contract's `Bytes[...]` emit literals.
 *
 * @param parts - The leading payload bytes, in emit order.
 * @returns The packed payload.
 */
export function packSignetEventPayload(
  ...parts: (Uint8Array | number)[]
): Uint8Array {
  const payload = new Uint8Array(SIGNET_EVENT_PAYLOAD_LENGTH);
  let offset = 0;
  for (const part of parts) {
    if (typeof part === "number") {
      payload[offset] = part;
      offset += 1;
    } else {
      payload.set(part, offset);
      offset += part.length;
    }
  }
  return payload;
}

/**
 * The event the `signBidirectional` circuit emits for a notification record:
 * version (1) ++ packed notification payload (128) ++ zeros.
 *
 * @param record - The raw notification record.
 * @returns The event as a stub source serves it.
 */
export function notificationEventOf(
  record: SignBidirectionalNotificationRecord,
): SignetMiscEvent {
  return {
    name: SignetEventName.SignBidirectionalEvent,
    payload: packSignetEventPayload(Number(record.version), record.payload),
  };
}

/**
 * The event the `respond` circuit emits for a signature response:
 * bigR.x (32) ++ bigR.y (32) ++ s (32) ++ recoveryId (1) ++ zeros.
 *
 * @param record - The response record.
 * @returns The event as a stub source serves it.
 */
export function signatureRespondedEventOf(
  record: SignatureRespondedEvent,
): SignetMiscEvent {
  return {
    name: SignetEventName.SignatureRespondedEvent,
    payload: packSignetEventPayload(
      record.signature.bigR.x,
      record.signature.bigR.y,
      record.signature.s,
      Number(record.signature.recoveryId),
    ),
  };
}

/**
 * The event the `respondBidirectional` circuit emits for an attestation:
 * the same packed `Signature` layout as {@link signatureRespondedEventOf}
 * under its own name.
 *
 * @param record - The attestation record.
 * @returns The event as a stub source serves it.
 */
export function respondBidirectionalEventOf(
  record: RespondBidirectionalEvent,
): SignetMiscEvent {
  return {
    name: SignetEventName.RespondBidirectionalEvent,
    payload: packSignetEventPayload(
      record.signature.bigR.x,
      record.signature.bigR.y,
      record.signature.s,
      Number(record.signature.recoveryId),
    ),
  };
}
