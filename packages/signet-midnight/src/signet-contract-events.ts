// MPC-/client-style decoders for the central SIGNET contract's emitted
// events. Every signet contract circuit emits one `Misc` contract event
// (MIP-0002 public log emission) whose 32-byte name tags the event kind and
// whose 256-byte payload packs the record:
//   SignBidirectionalEvent    - version (1) ++ requestId (32) ++ notification payload (128) ++ zeros (95)
//   SignatureRespondedEvent   - requestId (32) ++ bigR.x (32) ++ bigR.y (32) ++ s (32) ++ recoveryId (1) ++ zeros (127)
//   RespondBidirectionalEvent - requestId (32) ++ bigR.x (32) ++ bigR.y (32) ++ s (32) ++ recoveryId (1) ++ zeros (127)
// The decoders here are the byte-plumbing twins of the emit literals in
// signet-contract.compact: field order and offsets must match byte-for-byte
// (the signet-contract simulator tests pin the lockstep against real emits).
// Every event is UNAUTHENTICATED: verification is the reader's job. The
// request id every payload discloses is routing data only, so it scopes
// reads to one request and proves nothing.

import {
  CompactTypeBytes,
  type LogEvent,
} from "@midnight-ntwrk/compact-runtime";

import {
  bytesToHex,
  hexToBytes,
} from "./signet-requests.ts";

/**
 * The event names the signet contract emits, exactly as the contract's
 * `emit` literals spell them (the on-wire name is this string NUL-padded to
 * {@link SIGNET_EVENT_NAME_LENGTH} bytes, see {@link decodeSignetEventName}).
 */
export enum SignetEventName {
  /** A client's cross-contract signature-request notification. */
  SignBidirectionalEvent = "SignBidirectionalEvent",
  /** The MPC's signature response to a request. */
  SignatureRespondedEvent = "SignatureRespondedEvent",
  /** The MPC's respond-bidirectional attestation of a foreign execution. */
  RespondBidirectionalEvent = "RespondBidirectionalEvent",
}

/** Byte width of a signet event's name (Compact `pad(32, ...)`). */
export const SIGNET_EVENT_NAME_LENGTH = 32;

/** Byte width of every signet event's packed payload. */
export const SIGNET_EVENT_PAYLOAD_LENGTH = 256;

/**
 * A signet contract event in decoded form: the NUL-trimmed name and the full
 * re-padded {@link SIGNET_EVENT_PAYLOAD_LENGTH}-byte payload. This is the
 * one shape every source (simulator log, indexer Misc event) normalizes to
 * before the per-event payload decoders run.
 */
export interface SignetMiscEvent {
  /** The event name, NUL padding stripped (compare to {@link SignetEventName}). */
  name: string;
  /** The packed payload, re-padded to {@link SIGNET_EVENT_PAYLOAD_LENGTH} bytes. */
  payload: Uint8Array;
}

/**
 * Source of the signet contract's emitted events, the event-side sibling of
 * {@link SignetPublicStateSource}. Declared structurally so tests can satisfy
 * it with a plain stub; adapt a full midnight-js `PublicDataProvider` with
 * {@link signetEventSourceFromPublicDataProvider}.
 */
export interface SignetEventSource {
  /**
   * Fetch every signet event the contract has emitted so far, in emission
   * order.
   *
   * @param contractAddress - The signet contract to read events of.
   * @returns The decoded events, oldest first.
   */
  querySignetEvents(contractAddress: string): Promise<SignetMiscEvent[]>;
}

/** Descriptor re-padding a name ++ payload event atom to its full width. */
const eventBytes = new CompactTypeBytes(
  SIGNET_EVENT_NAME_LENGTH + SIGNET_EVENT_PAYLOAD_LENGTH,
);

/**
 * Strip the NUL padding off a fixed-width event name and decode it as ASCII:
 * the inverse of the contract's `pad(32, "...")`.
 *
 * @param name - The padded name bytes.
 * @returns The trimmed name string.
 */
export function decodeSignetEventName(name: Uint8Array): string {
  let end = name.length;
  while (end > 0 && name[end - 1] === 0) {
    end -= 1;
  }
  return new TextDecoder().decode(name.slice(0, end));
}

/**
 * Decode the simulator's circuit-execution log into signet events: keep the
 * `misc` emissions (of `contractAddress` when given), re-pad each to the full
 * name ++ payload width, and split. Non-signet-shaped `misc` events (wrong
 * atom shape or width) throw: in the simulator the emitting contract is under
 * test, so a malformed event is a bug, not noise to skip.
 *
 * @param events - The `context.events` of a `CircuitResults`.
 * @param contractAddress - Optional filter: only events this contract emitted.
 * @returns The decoded events, in emission order.
 * @throws Error when a `misc` event is not a single bytes atom of the signet
 *   name ++ payload width.
 */
export function decodeSignetLogEvents(
  events: readonly LogEvent[],
  contractAddress?: string,
): SignetMiscEvent[] {
  const out: SignetMiscEvent[] = [];
  for (const event of events) {
    if (event.eventType !== "misc") continue;
    if (contractAddress !== undefined && event.address !== contractAddress) {
      continue;
    }
    if (event.data.tag !== "cell") {
      throw new Error(
        `misc event data is a '${event.data.tag}', expected a cell`,
      );
    }
    // fromValue consumes its input and re-pads the trailing zeros the state
    // layer trims, so hand it a copy.
    const bytes = eventBytes.fromValue([...event.data.content.value]);
    out.push({
      name: decodeSignetEventName(bytes.slice(0, SIGNET_EVENT_NAME_LENGTH)),
      payload: bytes.slice(SIGNET_EVENT_NAME_LENGTH),
    });
  }
  return out;
}

/**
 * The least of a midnight-js `PublicDataProvider` the event source adapter
 * needs: the `Misc` contract events of one address. Structural, so any full
 * provider (e.g. `indexerPublicDataProvider`) is assignable.
 */
export interface SignetContractEventQuerySource {
  /**
   * Retrieve a contract's events; see
   * `PublicDataProvider.queryContractEvents`.
   *
   * @param filter - The contract address and event-type narrowing.
   * @returns The matching events, oldest first.
   */
  queryContractEvents(filter: {
    contractAddress: string;
    types?: "Misc"[];
  }): Promise<{ eventType: string; name?: string; payload?: string }[]>;
}

/**
 * Normalize one indexer-served hex field that may or may not carry a `0x`
 * prefix into bytes.
 *
 * @param hex - The hex string.
 * @returns The decoded bytes.
 */
function eventFieldBytes(hex: string): Uint8Array {
  return hexToBytes(hex.startsWith("0x") ? hex.slice(2) : hex);
}

/**
 * Adapt a midnight-js `PublicDataProvider` (or anything exposing its
 * `queryContractEvents`) into a {@link SignetEventSource}: query the `Misc`
 * events and normalize each into a {@link SignetMiscEvent}. The indexer
 * serves `name` and `payload` as hex-encoded byte strings; the name is
 * NUL-trimmed and the payload re-padded to the full
 * {@link SIGNET_EVENT_PAYLOAD_LENGTH}.
 *
 * @param provider - The provider to query events through.
 * @returns The adapted event source.
 */
export function signetEventSourceFromPublicDataProvider(
  provider: SignetContractEventQuerySource,
): SignetEventSource {
  return {
    async querySignetEvents(contractAddress) {
      const events = await provider.queryContractEvents({
        contractAddress,
        types: ["Misc"],
      });
      const out: SignetMiscEvent[] = [];
      for (const event of events) {
        if (event.eventType !== "Misc") continue;
        if (event.name === undefined || event.payload === undefined) continue;
        const payload = eventFieldBytes(event.payload);
        const padded = new Uint8Array(SIGNET_EVENT_PAYLOAD_LENGTH);
        padded.set(payload.slice(0, SIGNET_EVENT_PAYLOAD_LENGTH), 0);
        out.push({
          name: decodeSignetEventName(eventFieldBytes(event.name)),
          payload: padded,
        });
      }
      return out;
    },
  };
}

/**
 * A curve point in affine coordinates (Compact `AffinePoint`), SEC1
 * big-endian, the same shape the sig-net EVM and Solana signer contracts
 * expose.
 */
export interface AffinePoint {
  /** The x coordinate, 32 big-endian bytes. */
  x: Uint8Array;
  /** The y coordinate, 32 big-endian bytes. */
  y: Uint8Array;
}

/**
 * The MPC's canonical ECDSA signature as both respond events carry it
 * (Compact `Signature`, matching the MPC's own
 * `Signature { big_r, s, recovery_id }` and the EVM/Solana signer
 * contracts): `bigR` the full nonce point so consumers never decompress,
 * `s` big-endian, `recoveryId` the parity of R.y. Emitted UNVERIFIED like
 * everything else on the singleton. Convert with
 * `ecdsaSignatureToMpcSignature` / `mpcSignatureToEcdsaSignature`.
 */
export interface MpcSignature {
  /** The signature's nonce point R. */
  bigR: AffinePoint;
  /** Signature scalar s, 32 big-endian bytes. */
  s: Uint8Array;
  /** Recovery id (parity of R.y): 0 or 1. */
  recoveryId: bigint;
}

/**
 * The MPC's signature over the requested EVM transaction (Compact
 * `SignatureRespondedEvent`): decode to an ethers signature with
 * `signatureRespondedEventToSignature`. The emitting event carries the
 * record beside the request id it answers (see {@link SignetEventPost});
 * the id routes, and VERIFYING the signature against the transaction the
 * request describes establishes authenticity (see
 * {@link SignetRequestResponseReader.getVerifiedSignatureRespondedEvent}).
 */
export interface SignatureRespondedEvent {
  /** The requested signature over the transaction the request describes. */
  signature: MpcSignature;
}

/**
 * The MPC's respond-bidirectional attestation of a request's remote EVM
 * execution (Compact `RespondBidirectionalEvent`): the ECDSA signature over
 * the attestation digest `keccak256(requestId || serializedOutput)`. Both the
 * digest and the output travel off chain: readers fetch the output, recompute
 * the digest (`calculateSignetAttestationDigest`) and verify the signature
 * over it. Emitted UNVERIFIED by the signet contract, beside the request id
 * it answers (see {@link SignetEventPost}), so that signature check
 * against the expected MPC response key is the only thing separating a
 * genuine post from garbage: in-circuit via
 * `verifyRespondBidirectionalEvent`, off chain via
 * {@link verifyRespondBidirectionalSignature}.
 */
export interface RespondBidirectionalEvent {
  /** ECDSA signature over the attestation digest. */
  signature: MpcSignature;
}

/**
 * A decoded signet event payload: the request id the emitting circuit
 * disclosed beside the posted record. The id is UNAUTHENTICATED routing
 * data: it scopes reads to one request and proves nothing. For the respond
 * events, verifying the record's signature against the request remains the
 * authenticity check (see
 * {@link SignetRequestResponseReader.getVerifiedSignatureRespondedEvent} and
 * {@link SignetRequestResponseReader.getVerifiedRespondBidirectionalEvent});
 * for the notification, reading the declared request back from the named
 * caller's own ledger does (see signet-request-feed.ts).
 */
export interface SignetEventPost<TRecord> {
  /** The request id the post declares it concerns, 32 bytes. Routing data only. */
  requestId: Uint8Array;
  /** The posted record, verbatim. */
  event: TRecord;
}

/** Offsets of the leaves both respond payloads pack, in emit order. */
const RESPOND_REQUEST_ID_OFFSET = 0;
const SIGNATURE_BIG_R_X_OFFSET = 32;
const SIGNATURE_BIG_R_Y_OFFSET = 64;
const SIGNATURE_S_OFFSET = 96;
const SIGNATURE_RECOVERY_ID_OFFSET = 128;

/**
 * Unpack the leaves both respond payloads lead with:
 * requestId (32) ++ bigR.x (32) ++ bigR.y (32) ++ s (32) ++ recoveryId (1).
 * Bytes beyond the recovery id are padding today and are ignored, so a
 * future payload extension does not break existing readers.
 *
 * @param payload - The full event payload.
 * @returns The declared request id and the decoded signature.
 * @throws Error when the payload is too short to hold the packed leaves.
 */
function decodeRespondPayload(payload: Uint8Array): {
  requestId: Uint8Array;
  signature: MpcSignature;
} {
  const recoveryId = payload[SIGNATURE_RECOVERY_ID_OFFSET];
  if (recoveryId === undefined) {
    throw new Error(
      `signet event payload of ${payload.length} bytes is too short for a packed respond record`,
    );
  }
  return {
    requestId: payload.slice(
      RESPOND_REQUEST_ID_OFFSET,
      SIGNATURE_BIG_R_X_OFFSET,
    ),
    signature: {
      bigR: {
        x: payload.slice(SIGNATURE_BIG_R_X_OFFSET, SIGNATURE_BIG_R_Y_OFFSET),
        y: payload.slice(SIGNATURE_BIG_R_Y_OFFSET, SIGNATURE_S_OFFSET),
      },
      s: payload.slice(SIGNATURE_S_OFFSET, SIGNATURE_RECOVERY_ID_OFFSET),
      recoveryId: BigInt(recoveryId),
    },
  };
}

/**
 * Decode a {@link SignetEventName.SignatureRespondedEvent} payload: the
 * decode twin of the `respond` circuit's emit literal.
 *
 * @param payload - The event's payload.
 * @returns The decoded post: declared request id plus record.
 * @throws Error when the payload is too short to hold the packed leaves.
 */
export function decodeSignatureRespondedEventPayload(
  payload: Uint8Array,
): SignetEventPost<SignatureRespondedEvent> {
  const { requestId, signature } = decodeRespondPayload(payload);
  return { requestId, event: { signature } };
}

/**
 * Decode a {@link SignetEventName.RespondBidirectionalEvent} payload: the
 * decode twin of the `respondBidirectional` circuit's emit literal.
 *
 * @param payload - The event's payload.
 * @returns The decoded post: declared request id plus record.
 * @throws Error when the payload is too short to hold the packed leaves.
 */
export function decodeRespondBidirectionalEventPayload(
  payload: Uint8Array,
): SignetEventPost<RespondBidirectionalEvent> {
  const { requestId, signature } = decodeRespondPayload(payload);
  return { requestId, event: { signature } };
}

/**
 * Raw twin of the Compact `SignBidirectionalEventNotification` struct as the
 * `signBidirectional` circuit emits it: the version tag plus the still-packed
 * 128-byte payload. Decode the payload with
 * {@link decodeSignBidirectionalNotification}.
 */
export interface SignBidirectionalNotificationRecord {
  /** Payload layout tag (Compact `Uint<8>`): 1 = the V1 layout. */
  version: bigint;
  /** The packed payload bytes, exactly as the registering circuit built them. */
  payload: Uint8Array;
}

/** Offset of the notification's version tag in the event payload. */
const NOTIFICATION_EVENT_VERSION_OFFSET = 0;

/** Offset of the declared request id in the event payload. */
const NOTIFICATION_EVENT_REQUEST_ID_OFFSET = 1;

/** Offset of the packed notification payload in the event payload. */
const NOTIFICATION_EVENT_PAYLOAD_OFFSET = 33;

/** Byte width of the packed notification payload (Compact `Bytes<128>`). */
const NOTIFICATION_PAYLOAD_LENGTH = 128;

/**
 * Decode a {@link SignetEventName.SignBidirectionalEvent} payload into the
 * declared request id and the raw notification record: the decode twin of
 * the `signBidirectional` circuit's emit literal
 * (version (1) ++ requestId (32) ++ notification payload (128)).
 *
 * @param payload - The event's payload.
 * @returns The decoded post: declared request id plus raw notification record.
 * @throws Error when the payload is too short to hold the record.
 */
export function decodeSignBidirectionalEventNotificationPayload(
  payload: Uint8Array,
): SignetEventPost<SignBidirectionalNotificationRecord> {
  const version = payload[NOTIFICATION_EVENT_VERSION_OFFSET];
  const end = NOTIFICATION_EVENT_PAYLOAD_OFFSET + NOTIFICATION_PAYLOAD_LENGTH;
  if (version === undefined || payload.length < end) {
    throw new Error(
      `signet event payload of ${payload.length} bytes is too short for a packed notification`,
    );
  }
  return {
    requestId: payload.slice(
      NOTIFICATION_EVENT_REQUEST_ID_OFFSET,
      NOTIFICATION_EVENT_PAYLOAD_OFFSET,
    ),
    event: {
      version: BigInt(version),
      payload: payload.slice(NOTIFICATION_EVENT_PAYLOAD_OFFSET, end),
    },
  };
}

/** Offset of the V1 `callerAddress` in the packed payload (`Bytes<32>` at the front). */
const NOTIFICATION_CALLER_ADDRESS_OFFSET = 0;

/** Offset of the V1 `requestsPathDepth` (after the 32 callerAddress bytes). */
const NOTIFICATION_PATH_DEPTH_OFFSET = 32;

/** Offset of the V1 `requestsPath` bytes (after the 1-byte depth). */
const NOTIFICATION_PATH_OFFSET = 33;

/**
 * Maximum ledger-tree path depth the V1 payload carries, matching the
 * `Vector<4, Uint<8>>` the `constructSignBidirectionalEventNotificationV1`
 * circuit packs. Depth 1 addresses up to 15 fields, depth 4 up to 15^4.
 */
const MAX_LEDGER_PATH_DEPTH = 4;

/** The only payload interpretation {@link decodeSignBidirectionalNotification} understands today. */
const SUPPORTED_NOTIFICATION_VERSION = 1n;

/**
 * A decoded V1 notification: the flat pointer a client emitted to tell the
 * MPC a request was stored, and WHERE to read the authenticated copy. The
 * emitting event declares the stored request's id beside this record (see
 * {@link SignetEventPost}): the MPC looks that id up in the request map the
 * notification points at and reads the request from the named caller's own
 * authenticated ledger (see signet-request-feed.ts). The fields themselves
 * confer no authority.
 */
export interface SignBidirectionalNotification {
  /** Payload layout tag: this decoder only produces version 1. */
  version: number;
  /**
   * Address of the contract whose request map holds the request, rendered
   * as lowercase hex, no `0x` prefix: directly usable as a
   * `queryContractState` argument. The MPC reads requests from THIS
   * contract's authenticated state. The field itself confers no authority.
   */
  callerAddress: string;
  /**
   * Resolved ledger-tree path of the `SignBidirectionalEventMap` in
   * {@link callerAddress}, as compactc records it in that contract's
   * `contract-info.json` (`"index"`): `[4]` for a flat contract's field 4,
   * `[1, 14]` once chunking applies. The reader follows it node for node
   * (see `signetFieldNodeByPath`) and never assumes a layout.
   */
  requestsPath: number[];
}

/**
 * Unpack a {@link SignBidirectionalNotificationRecord}'s payload by the
 * fixed V1 offsets: the decode twin of the compiled
 * `constructSignBidirectionalEventNotificationV1` circuit (byte plumbing
 * only: the pack↔decode lockstep is pinned by the unit test that round-trips
 * through the real circuit). V1 layout:
 * callerAddress (32) ++ requestsPathDepth (1) ++ requestsPath (4) ++ zero
 * padding (91), where only the first `requestsPathDepth` path bytes are
 * meaningful.
 *
 * Fails closed on an unrecognised `version`: a future payload layout adds a
 * branch here rather than silently misinterpreting bytes under the V1 offsets.
 *
 * @param record - The raw notification record.
 * @returns The decoded notification, its `requestsPath` trimmed to the
 *   declared depth.
 * @throws Error if the record's `version` is not one this decoder understands,
 *   or its `requestsPathDepth` is zero or exceeds {@link MAX_LEDGER_PATH_DEPTH}.
 */
export function decodeSignBidirectionalNotification(
  record: SignBidirectionalNotificationRecord,
): SignBidirectionalNotification {
  if (record.version !== SUPPORTED_NOTIFICATION_VERSION) {
    throw new Error(
      `SignBidirectionalEventNotification version ${record.version} is not supported ` +
        `(this decoder understands version ${SUPPORTED_NOTIFICATION_VERSION})`,
    );
  }
  const callerAddress = bytesToHex(
    record.payload.slice(
      NOTIFICATION_CALLER_ADDRESS_OFFSET,
      NOTIFICATION_PATH_DEPTH_OFFSET,
    ),
  );
  const depth = record.payload[NOTIFICATION_PATH_DEPTH_OFFSET];
  if (depth === undefined || depth < 1 || depth > MAX_LEDGER_PATH_DEPTH) {
    throw new Error(
      `SignBidirectionalEventNotification requestsPathDepth ${depth} is out of range ` +
        `(expected 1 to ${MAX_LEDGER_PATH_DEPTH})`,
    );
  }
  // payload is a re-padded Bytes<128> and depth is bounded to MAX_LEDGER_PATH_DEPTH
  // above, so this slice always yields exactly `depth` bytes.
  const requestsPath = Array.from(
    record.payload.slice(NOTIFICATION_PATH_OFFSET, NOTIFICATION_PATH_OFFSET + depth),
  );
  return {
    version: Number(record.version),
    callerAddress,
    requestsPath,
  };
}
