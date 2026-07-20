// MPC-/client-style raw state reader for the central SIGNET contract: decode
// its ledger fields out of a contract's raw state WITHOUT the compiled
// contract, the mirror image of signature-requests-state-reader.ts. A poller
// has only the contract address, queries raw state from the indexer
// (queryContractState(address).data), and decodes by the signet contract
// layout convention (see "Signet Contract Ledger Layout" in Signet.compact):
// signature response counter index (field 0), signature response log
// (field 1), respond-bidirectional index (field 2), sealed MPC key hash
// (field 3), notification registry (field 4). The generic state-tree walk
// (RawContractState, signetFieldNode) and the shared base descriptors live in
// signature-state-reading.ts.

import {
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  type CompactType,
} from "@midnight-ntwrk/compact-runtime";

import {
  bytesToHex,
  requestIdHex,
  type RequestId,
  type RequestIdHex,
} from "./signet-requests.ts";

import {
  requestIdType,
  signetFieldNode,
  u64,
  type RawContractState,
} from "./signature-state-reading.ts";

/** Signet contract layout: the signature response counter index is ledger field 0. */
export const SIGNATURE_RESPONSE_COUNTER_INDEX_FIELD = 0;

/** Signet contract layout: the signature response log is ledger field 1. */
export const SIGNATURE_RESPONSE_INDEX_FIELD = 1;

/** Signet contract layout: the respond-bidirectional index is ledger field 2. */
export const RESPOND_BIDIRECTIONAL_INDEX_FIELD = 2;

/** Signet contract layout: the sealed MPC attestation key hash is ledger field 3. */
export const MPC_PUB_KEY_HASH_FIELD = 3;

/** Signet contract layout: the request notification registry is ledger field 4. */
export const SIGN_BIDIRECTIONAL_NOTIFICATION_INDEX_FIELD = 4;

// ---- Type descriptors (must mirror Signet.compact field-for-field) ----
// As in the requests reader, fromValue consumes the aligned value
// sequentially, so field order and width here must match the Compact structs
// exactly — a mismatch is silent data corruption, not an error.

/** Descriptor for a signature scalar / MPC key hash (`Bytes<32>`). */
const bytes32 = new CompactTypeBytes(32);

/** Descriptor for the attestation's serialized output (`Bytes<128>`). */
const bytes128 = new CompactTypeBytes(128);

/** Descriptor for a Compact `Uint<8>` (1-byte unsigned integer). */
const u8 = new CompactTypeUnsignedInteger(255n, 1);

/**
 * The MPC's secp256k1 signature over the requested EVM transaction (Compact
 * `SignatureResponse` — the canonical MPC `Signature { big_r, s,
 * recovery_id }` with `big_r` decomposed into affine coordinates, big-endian
 * scalar bytes). The request id it answers lives in the response index key,
 * not here.
 */
export interface SignatureResponse {
  /** Signature R.x, 32 big-endian bytes. */
  bigRx: Uint8Array;
  /** Signature R.y, 32 big-endian bytes. */
  bigRy: Uint8Array;
  /** Signature s, 32 big-endian bytes. */
  s: Uint8Array;
  /** Parity of R.y for public-key recovery (0 or 1). */
  recoveryId: bigint;
}

/**
 * Hand-composed descriptor for {@link SignatureResponse}. Field
 * order (bigRx, bigRy, s, recoveryId) must match the Compact struct.
 */
export const signatureResponseType: CompactType<SignatureResponse> = {
  /** @returns Compound alignment of the struct's fields in declaration order. */
  alignment() {
    return bytes32
      .alignment()
      .concat(bytes32.alignment())
      .concat(bytes32.alignment())
      .concat(u8.alignment());
  },
  /**
   * Decode one signature response from an aligned value, consuming it field
   * by field.
   *
   * @param value - Mutable aligned value cursor; pass a copy.
   * @returns The decoded record.
   */
  fromValue(value) {
    return {
      bigRx: bytes32.fromValue(value),
      bigRy: bytes32.fromValue(value),
      s: bytes32.fromValue(value),
      recoveryId: u8.fromValue(value),
    };
  },
  /**
   * Encode a signature response into its aligned on-ledger representation.
   *
   * @param record - The record to encode.
   * @returns The aligned value, fields concatenated in declaration order.
   */
  toValue(record) {
    return bytes32
      .toValue(record.bigRx)
      .concat(bytes32.toValue(record.bigRy))
      .concat(bytes32.toValue(record.s))
      .concat(u8.toValue(record.recoveryId));
  },
};

/**
 * The MPC's respond-bidirectional attestation of a request's remote EVM
 * execution (Compact `RespondBidirectional`): the serialized execution output
 * plus the secp256k1 ECDSA signature over the attestation digest
 * `signetAttestationMessage(requestId, serializedOutput, outputLen)`. Stored
 * records were verified IN-CIRCUIT by the signet contract at post time, so
 * readers can trust them without re-verifying. The signing public key is not
 * stored here — it is pinned by hash against the sealed MPC key.
 */
export interface RespondBidirectional {
  /** ABI-encoded return data (canonical serialized_output), zero-padded to 128 bytes. */
  serializedOutput: Uint8Array;
  /** Meaningful byte count of {@link serializedOutput}. */
  outputLen: bigint;
  /**
   * ECDSA signature scalar r as 32 LITTLE-ENDIAN bytes (the byte order the
   * `Secp256k1Scalar as Bytes<32>` cast produces; recover the scalar with
   * `bytesToBigint`).
   */
  sigR: Uint8Array;
  /** ECDSA signature scalar s as 32 little-endian bytes (see {@link sigR}). */
  sigS: Uint8Array;
}

/**
 * Composite key of one posted signature response (Compact
 * `SignetResponseKey`): the request id it answers plus this post's 0-based
 * count. Field order — count first, then request id — mirrors the Compact
 * struct.
 */
export interface SignetResponseKey {
  /** 0-based position of this post among the responses for {@link requestId}. */
  count: bigint;
  /** 32-byte id of the request this response answers. */
  requestId: RequestId;
}

/**
 * Hand-composed descriptor for {@link SignetResponseKey} — the map key of
 * the signature response log. Field order (count, then requestId) must match
 * the Compact struct.
 */
export const signetResponseKeyType: CompactType<SignetResponseKey> = {
  /** @returns Compound alignment of the struct's fields in declaration order. */
  alignment() {
    return u64.alignment().concat(requestIdType.alignment());
  },
  /**
   * Decode one key from an aligned value, consuming it field by field.
   *
   * @param value - Mutable aligned value cursor; pass a copy.
   * @returns The decoded composite key.
   */
  fromValue(value) {
    return {
      count: u64.fromValue(value),
      requestId: requestIdType.fromValue(value),
    };
  },
  /**
   * Encode a key into its aligned on-ledger representation.
   *
   * @param key - The composite key to encode.
   * @returns The aligned value, fields concatenated in declaration order.
   */
  toValue(key) {
    return u64.toValue(key.count).concat(requestIdType.toValue(key.requestId));
  },
};

/**
 * Hand-composed descriptor for {@link RespondBidirectional}. Field
 * order (serializedOutput, outputLen, sigR, sigS) must match the Compact
 * struct — the signature scalars are stored as `Bytes<32>`, not
 * `Secp256k1Scalar`.
 */
export const respondBidirectionalType: CompactType<RespondBidirectional> = {
  /** @returns Compound alignment of the struct's fields in declaration order. */
  alignment() {
    return bytes128
      .alignment()
      .concat(u8.alignment())
      .concat(bytes32.alignment())
      .concat(bytes32.alignment());
  },
  /**
   * Decode one attestation record from an aligned value, consuming it field
   * by field.
   *
   * @param value - Mutable aligned value cursor; pass a copy.
   * @returns The decoded record.
   */
  fromValue(value) {
    return {
      serializedOutput: bytes128.fromValue(value),
      outputLen: u8.fromValue(value),
      sigR: bytes32.fromValue(value),
      sigS: bytes32.fromValue(value),
    };
  },
  /**
   * Encode an attestation record into its aligned on-ledger representation.
   *
   * @param record - The record to encode.
   * @returns The aligned value, fields concatenated in declaration order.
   */
  toValue(record) {
    return bytes128
      .toValue(record.serializedOutput)
      .concat(u8.toValue(record.outputLen))
      .concat(bytes32.toValue(record.sigR))
      .concat(bytes32.toValue(record.sigS));
  },
};

/** Descriptor for the notification's packed V1 payload (`Bytes<65>`). */
const bytes65 = new CompactTypeBytes(65);

/**
 * Raw twin of the Compact `SignBidirectionalNotification` struct as stored
 * on-ledger: the version tag plus the still-packed 65-byte payload. Decode
 * the payload with {@link decodeSignBidirectionalNotification}.
 */
export interface SignBidirectionalNotificationRecord {
  /** Payload layout tag (Compact `Uint<8>`); 1 = the V1 layout. */
  version: bigint;
  /** The packed payload bytes, exactly as the registering circuit built them. */
  payload: Uint8Array;
}

/**
 * Hand-composed descriptor for {@link SignBidirectionalNotificationRecord}.
 * Field order (version, payload) must match the Compact struct.
 */
export const signBidirectionalNotificationType: CompactType<SignBidirectionalNotificationRecord> =
  {
    /** @returns Compound alignment of the struct's fields in declaration order. */
    alignment() {
      return u8.alignment().concat(bytes65.alignment());
    },
    /**
     * Decode one notification record from an aligned value, consuming it
     * field by field.
     *
     * @param value - Mutable aligned value cursor; pass a copy.
     * @returns The decoded record.
     */
    fromValue(value) {
      return {
        version: u8.fromValue(value),
        payload: bytes65.fromValue(value),
      };
    },
    /**
     * Encode a notification record into its aligned on-ledger representation.
     *
     * @param record - The record to encode.
     * @returns The aligned value, fields concatenated in declaration order.
     */
    toValue(record) {
      return u8.toValue(record.version).concat(bytes65.toValue(record.payload));
    },
  };

/** Offset of the V1 `callerAddress` in the packed payload (`Bytes<32>` at the front). */
const NOTIFICATION_CALLER_ADDRESS_OFFSET = 0;

/** Offset of the V1 `requestId` (after the 32 callerAddress bytes). */
const NOTIFICATION_REQUEST_ID_OFFSET = 32;

/** Offset of the V1 `requestsIndexField` (after callerAddress + requestId). */
const NOTIFICATION_REQUESTS_INDEX_FIELD_OFFSET = 64;

/** The only payload interpretation {@link decodeSignBidirectionalNotification} understands today. */
const SUPPORTED_NOTIFICATION_VERSION = 1n;

/**
 * A decoded V1 notification from the signet contract's registry: the flat
 * pointer a client registered to tell the MPC a request was stored — and
 * WHERE to read the authenticated copy. Never trusted on its own: the
 * resolver authenticates by reading the request back from
 * {@link callerAddress}'s own ledger (see signet-request-resolver.ts).
 */
export interface SignBidirectionalNotification {
  /** Payload layout tag; this decoder only produces version 1. */
  version: number;
  /**
   * Address of the contract whose request index holds the request, rendered
   * as lowercase hex, no `0x` prefix — directly usable as a
   * `queryContractState` argument. The MPC reads the request from THIS
   * contract's authenticated state; the field itself confers no authority.
   */
  callerAddress: string;
  /** Which request in {@link callerAddress}'s index this notification is about. */
  requestId: RequestIdHex;
  /**
   * Ledger field position of the `Map<RequestId, SignBidirectionalRequest>`
   * request index in {@link callerAddress} (the signet layout convention puts
   * it at field 0, but the notification carries it so the reader never assumes).
   */
  requestsIndexField: number;
}

/**
 * Unpack a stored {@link SignBidirectionalNotificationRecord}'s payload by
 * the fixed V1 offsets — the decode twin of the compiled
 * `constructSignBidirectionalNotificationV1` circuit (byte plumbing only; the
 * pack↔decode lockstep is pinned by the state-reader unit test that round-trips
 * through the real circuit).
 *
 * Fails closed on an unrecognised `version`: a future payload layout adds a
 * branch here rather than silently misinterpreting bytes under the V1 offsets.
 *
 * @param record - The raw on-ledger record.
 * @returns The decoded flat notification.
 * @throws Error if the record's `version` is not one this decoder understands.
 */
export function decodeSignBidirectionalNotification(
  record: SignBidirectionalNotificationRecord,
): SignBidirectionalNotification {
  if (record.version !== SUPPORTED_NOTIFICATION_VERSION) {
    throw new Error(
      `SignBidirectionalNotification version ${record.version} is not supported ` +
        `(this decoder understands version ${SUPPORTED_NOTIFICATION_VERSION})`,
    );
  }
  const callerAddress = bytesToHex(
    record.payload.slice(
      NOTIFICATION_CALLER_ADDRESS_OFFSET,
      NOTIFICATION_REQUEST_ID_OFFSET,
    ),
  );
  const requestId = requestIdHex(
    record.payload.slice(
      NOTIFICATION_REQUEST_ID_OFFSET,
      NOTIFICATION_REQUESTS_INDEX_FIELD_OFFSET,
    ),
  );
  const requestsIndexField =
    record.payload[NOTIFICATION_REQUESTS_INDEX_FIELD_OFFSET];
  return {
    version: Number(record.version),
    callerAddress,
    requestId,
    requestsIndexField,
  };
}

/**
 * Plain-JS notification registry parsed out of the ledger: hex request id
 * (the map KEY under which the notification was registered) to the raw
 * stored record. Decode each record with
 * {@link decodeSignBidirectionalNotification}.
 */
export type SignBidirectionalNotificationIndex = Map<
  RequestIdHex,
  SignBidirectionalNotificationRecord
>;

/**
 * Plain-JS signature response counter index parsed out of the ledger: hex
 * request id (see {@link requestIdHex}) to the number of responses posted for
 * that request. Entries in the response log exist for counts `0 .. value - 1`.
 */
export type SignatureResponseCounterIndex = Map<RequestIdHex, bigint>;

/**
 * Plain-JS signature response log parsed out of the ledger, keyed by
 * {@link signetResponseIndexKey} (`"<hexRequestId>:<count>"`) so the
 * composite Compact key survives as a usable JS `Map` key.
 */
export type SignatureResponseIndex = Map<string, SignatureResponse>;

/**
 * Plain-JS respond-bidirectional index parsed out of the ledger: hex
 * request id to the contract-verified attestation. One slot per request.
 */
export type RespondBidirectionalIndex = Map<
  RequestIdHex,
  RespondBidirectional
>;

/**
 * Build the {@link SignatureResponseIndex} key for a `(requestId, count)`
 * pair — the composite Compact key flattened to a string so it works as a JS
 * `Map` key.
 *
 * @param id - The request id the response answers, in canonical hex form.
 * @param count - 0-based post count within that request.
 * @returns `"<hexRequestId>:<count>"`.
 */
export function signetResponseIndexKey(
  id: RequestIdHex,
  count: bigint,
): string {
  return `${id}:${count}`;
}

/**
 * Read ONLY the notification registry (ledger field
 * {@link SIGN_BIDIRECTIONAL_NOTIFICATION_INDEX_FIELD}) out of raw signet
 * contract state — the poll-loop primitive of {@link SignetRequestFeed},
 * which cycles frequently and has no use for the response fields.
 *
 * @param raw - Raw contract state, e.g. `queryContractState(address).data`
 *   from the indexer or `ctx.currentQueryContext.state` from the simulator.
 * @returns The registry, keyed by the hex request id each record was
 *   registered under.
 * @throws Error if the field is missing or is not a Map.
 */
export function readSignBidirectionalNotificationIndexFromState(
  raw: RawContractState,
): SignBidirectionalNotificationIndex {
  const notificationMap = signetFieldNode(
    raw,
    SIGN_BIDIRECTIONAL_NOTIFICATION_INDEX_FIELD,
  ).asMap();
  if (notificationMap === undefined) {
    throw new Error(
      `Ledger field ${SIGN_BIDIRECTIONAL_NOTIFICATION_INDEX_FIELD} is not a Map`,
    );
  }
  const index: SignBidirectionalNotificationIndex = new Map();
  for (const key of notificationMap.keys()) {
    // fromValue consumes its input, so hand each descriptor a copy.
    const requestId = requestIdType.fromValue([...key.value]);
    const cell = notificationMap.get(key)?.asCell();
    if (cell === undefined) continue;
    index.set(
      requestIdHex(requestId),
      signBidirectionalNotificationType.fromValue([...cell.value]),
    );
  }
  return index;
}

/**
 * The decoded ledger fields of the signet contract: the signature response
 * counter (field 0) and log (field 1), the respond-bidirectional index
 * (field 2), the sealed MPC attestation key hash (field 3), and the request
 * notification registry (field 4). Together they give a poller everything
 * the contract ever records about a request.
 */
export interface SignetContractLedger {
  /**
   * The signature response counter index (ledger field
   * {@link SIGNATURE_RESPONSE_COUNTER_INDEX_FIELD}), keyed by hex request id.
   */
  signatureResponseCounterIndex: SignatureResponseCounterIndex;
  /**
   * The signature response log (ledger field
   * {@link SIGNATURE_RESPONSE_INDEX_FIELD}), keyed by
   * {@link signetResponseIndexKey}.
   */
  signatureResponseIndex: SignatureResponseIndex;
  /**
   * The respond-bidirectional index (ledger field
   * {@link RESPOND_BIDIRECTIONAL_INDEX_FIELD}), keyed by hex request id.
   */
  respondBidirectionalIndex: RespondBidirectionalIndex;
  /**
   * The sealed MPC attestation key hash (ledger field
   * {@link MPC_PUB_KEY_HASH_FIELD}) posts are verified against.
   */
  mpcPubKeyHash: Uint8Array;
  /**
   * The request notification registry (ledger field
   * {@link SIGN_BIDIRECTIONAL_NOTIFICATION_INDEX_FIELD}), keyed by hex
   * request id.
   */
  signBidirectionalNotificationIndex: SignBidirectionalNotificationIndex;
}

/**
 * MPC-/client-style read: parse the signet contract's ledger fields out of
 * raw contract state by field position alone — no compiled contract, no
 * generated `ledger()`, only the signet contract layout convention and the
 * canonical descriptors above.
 *
 * @param raw - Raw contract state, e.g. `queryContractState(address).data`
 *   from the indexer or `ctx.currentQueryContext.state` from the simulator.
 * @returns The decoded {@link SignetContractLedger}.
 * @throws Error if a field is missing or has the wrong state-value shape.
 */
export function readSignetContractLedgerFromState(
  raw: RawContractState,
): SignetContractLedger {
  const counterMap = signetFieldNode(
    raw,
    SIGNATURE_RESPONSE_COUNTER_INDEX_FIELD,
  ).asMap();
  if (counterMap === undefined) {
    throw new Error(
      `Ledger field ${SIGNATURE_RESPONSE_COUNTER_INDEX_FIELD} is not a Map`,
    );
  }
  const signatureResponseCounterIndex: SignatureResponseCounterIndex =
    new Map();
  for (const key of counterMap.keys()) {
    // fromValue consumes its input, so hand each descriptor a copy.
    const requestId = requestIdType.fromValue([...key.value]);
    // A Counter is stored as a plain u64 cell.
    const cell = counterMap.get(key)?.asCell();
    if (cell === undefined) continue;
    signatureResponseCounterIndex.set(
      requestIdHex(requestId),
      u64.fromValue([...cell.value]),
    );
  }

  const responseMap = signetFieldNode(
    raw,
    SIGNATURE_RESPONSE_INDEX_FIELD,
  ).asMap();
  if (responseMap === undefined) {
    throw new Error(`Ledger field ${SIGNATURE_RESPONSE_INDEX_FIELD} is not a Map`);
  }
  const signatureResponseIndex: SignatureResponseIndex = new Map();
  for (const key of responseMap.keys()) {
    const responseKey = signetResponseKeyType.fromValue([...key.value]);
    const cell = responseMap.get(key)?.asCell();
    if (cell === undefined) continue;
    signatureResponseIndex.set(
      signetResponseIndexKey(requestIdHex(responseKey.requestId), responseKey.count),
      signatureResponseType.fromValue([...cell.value]),
    );
  }

  const respondBidirectionalMap = signetFieldNode(
    raw,
    RESPOND_BIDIRECTIONAL_INDEX_FIELD,
  ).asMap();
  if (respondBidirectionalMap === undefined) {
    throw new Error(
      `Ledger field ${RESPOND_BIDIRECTIONAL_INDEX_FIELD} is not a Map`,
    );
  }
  const respondBidirectionalIndex: RespondBidirectionalIndex = new Map();
  for (const key of respondBidirectionalMap.keys()) {
    const requestId = requestIdType.fromValue([...key.value]);
    const cell = respondBidirectionalMap.get(key)?.asCell();
    if (cell === undefined) continue;
    respondBidirectionalIndex.set(
      requestIdHex(requestId),
      respondBidirectionalType.fromValue([...cell.value]),
    );
  }

  const hashCell = signetFieldNode(raw, MPC_PUB_KEY_HASH_FIELD).asCell();
  if (hashCell === undefined) {
    throw new Error(`Ledger field ${MPC_PUB_KEY_HASH_FIELD} is not a Cell`);
  }
  const mpcPubKeyHash = bytes32.fromValue([...hashCell.value]);

  return {
    signatureResponseCounterIndex,
    signatureResponseIndex,
    respondBidirectionalIndex,
    mpcPubKeyHash,
    signBidirectionalNotificationIndex:
      readSignBidirectionalNotificationIndexFromState(raw),
  };
}
