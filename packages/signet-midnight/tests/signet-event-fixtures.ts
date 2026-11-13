// Test-local ENCODE twins of the signet contracts' emit literals: build the
// SignetMiscEvent shapes the feed/reader tests serve through stub event
// sources. Encode-side only and test-only on purpose: the decode side lives
// in src/signet-contract-events.ts, and its lockstep against the REAL
// contract emits is pinned by the signet-contract and signet-responder
// packages' simulator tests (which run the actual circuits and decode their
// events). A drift in these fixtures shows up there, not here.

import {
  bigintToBytes32,
  type IndexedSignetMiscEvent,
  type RespondBidirectionalEvent,
  type SignatureRespondedEvent,
  type SignBidirectionalNotificationRecord,
  SIGNET_EVENT_PAYLOAD_LENGTH,
  SignetEventName,
  type SignetMiscEvent,
} from "../src/index.ts";

/**
 * Concatenate payload parts and zero-pad to the full signet event payload
 * width, mirroring the contract's `Bytes[...]` emit literals.
 *
 * @param parts - The leading payload bytes, in emit order.
 * @returns The packed payload.
 */
export function packSignetEventPayload(...parts: (Uint8Array | number)[]): Uint8Array {
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
 * version (1) ++ requestId (32) ++ packed notification payload (128) ++
 * zeros.
 *
 * @param requestId - The stored request id the notification declares, 32 bytes.
 * @param record - The raw notification record.
 * @returns The event as a stub source serves it.
 */
export function notificationEventOf(
  requestId: Uint8Array,
  record: SignBidirectionalNotificationRecord,
): SignetMiscEvent {
  return {
    name: SignetEventName.SignBidirectionalEvent,
    payload: packSignetEventPayload(Number(record.version), requestId, record.payload),
  };
}

/**
 * The event the `respond` circuit emits for a signature response:
 * requestId (32) ++ bigR.x (32) ++ bigR.y (32) ++ s (32) ++ recoveryId (1)
 * ++ zeros.
 *
 * @param requestId - The request id the post declares it answers, 32 bytes.
 *   Packed in place of the record's own, so a test can serve a record under
 *   a foreign id.
 * @param record - The response record.
 * @returns The event as a stub source serves it.
 */
export function signatureRespondedEventOf(
  requestId: Uint8Array,
  record: SignatureRespondedEvent,
): SignetMiscEvent {
  return {
    name: SignetEventName.SignatureRespondedEvent,
    payload: packSignetEventPayload(
      requestId,
      record.signature.bigR.x,
      record.signature.bigR.y,
      record.signature.s,
      Number(record.signature.recoveryId),
    ),
  };
}

/**
 * The event the `respondBidirectional` circuit emits for an attestation:
 * requestId (32) ++ blockHeight (8) ++ outputKind (1) ++
 * serializedOutputLength (8) ++ outputHash (32) ++ digest (32) ++ bigR.x (32)
 * ++ bigR.y (32) ++ s (32) ++ recoveryId (1) ++ zeros. The two `Uint<64>` leaves are
 * little-endian (Compact's `Uint<64>` to `Bytes<8>` cast) and the kind is
 * the enum's variant index.
 *
 * @param requestId - The request id the post declares it answers, 32 bytes.
 *   Packed in place of the record's own, so a test can serve a record under
 *   a foreign id.
 * @param record - The attestation record.
 * @returns The event as a stub source serves it.
 */
export function respondBidirectionalEventOf(
  requestId: Uint8Array,
  record: RespondBidirectionalEvent,
): SignetMiscEvent {
  return {
    name: SignetEventName.RespondBidirectionalEvent,
    payload: packSignetEventPayload(
      requestId,
      bigintToBytes32(record.blockHeight).subarray(0, 8),
      record.outputKind,
      bigintToBytes32(record.serializedOutputLength).subarray(0, 8),
      record.outputHash,
      record.digest,
      record.signature.bigR.x,
      record.signature.bigR.y,
      record.signature.s,
      Number(record.signature.recoveryId),
    ),
  };
}

/**
 * Serve fixture events as the async stream a stub {@link SignetEventSource}
 * returns: every item, in order, one per pull.
 *
 * @param events - The events to serve.
 * @returns The stream.
 */
export function streamOf<T>(events: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => {
      const iterator = events[Symbol.iterator]();
      return { next: () => Promise.resolve(iterator.next()) };
    },
  };
}

/**
 * Dress fixture events as the indexer serves them: event `i` (0-based) gets
 * id `i + 1` and sits alone in block `firstBlockHeight + i`.
 *
 * @param events - The events, in emission order.
 * @param firstBlockHeight - Height of the block holding the first event.
 * @returns The events with their indexer cursor and block.
 */
export function indexedEventsOf(
  events: readonly SignetMiscEvent[],
  firstBlockHeight = 1,
): IndexedSignetMiscEvent[] {
  return events.map((event, position) => ({
    ...event,
    id: position + 1,
    maxId: events.length,
    transactionId: position + 1,
    transactionHash: (position + 1).toString(16).padStart(64, "0"),
    blockHeight: firstBlockHeight + position,
    blockHash: (firstBlockHeight + position).toString(16).padStart(64, "0"),
    blockTimestamp: new Date(0),
  }));
}
