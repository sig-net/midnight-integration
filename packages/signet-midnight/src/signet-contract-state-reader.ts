// MPC-/client-style raw state reader for the central SIGNET contract: decode
// its ledger fields out of a contract's raw state WITHOUT the compiled
// contract, the mirror image of signature-requests-state-reader.ts. A poller
// has only the contract address, queries raw state from the indexer
// (queryContractState(address).data), and decodes by the signet contract's
// declaration-order layout:
//   field 0: signBidirectionalEventNotificationCounterMap (Map<RequestId, Counter>)
//   field 1: signBidirectionalEventNotificationMap (Map<SignetMapKey, Notification>)
//   field 2: respondCounterMap (Map<RequestId, Counter>)
//   field 3: respondMap (Map<SignetMapKey, SignatureRespondedEvent>)
//   field 4: respondBidirectionalCounterMap (Map<RequestId, Counter>)
//   field 5: respondBidirectionalMap (Map<SignetMapKey, RespondBidirectionalEvent>)
// Every store is an unauthenticated append-only log keyed by
// (requestId, count): verification is the reader's job. The generic
// state-tree walk (RawContractState, signetFieldNodeByPath) and the shared base
// descriptors live in signature-state-reading.ts.

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
  signetFieldNodeByPath,
  u64,
  type RawContractState,
} from "./signature-state-reading.ts";

/** Signet contract layout: the notification counter map is ledger field 0. */
export const SIGN_BIDIRECTIONAL_EVENT_NOTIFICATION_COUNTER_MAP_FIELD = 0;

/** Signet contract layout: the notification map is ledger field 1. */
export const SIGN_BIDIRECTIONAL_EVENT_NOTIFICATION_MAP_FIELD = 1;

/** Signet contract layout: the `respond` counter map is ledger field 2. */
export const RESPOND_COUNTER_MAP_FIELD = 2;

/** Signet contract layout: the `respond` post log is ledger field 3. */
export const RESPOND_MAP_FIELD = 3;

/** Signet contract layout: the respond-bidirectional counter map is ledger field 4. */
export const RESPOND_BIDIRECTIONAL_COUNTER_MAP_FIELD = 4;

/** Signet contract layout: the respond-bidirectional map is ledger field 5. */
export const RESPOND_BIDIRECTIONAL_MAP_FIELD = 5;

// ---- Type descriptors (must mirror Signet.compact field-for-field) ----
// As in the requests reader, fromValue consumes the aligned value
// sequentially, so field order and width here must match the Compact structs
// exactly: a mismatch is silent data corruption, not an error.

/** Descriptor for a 32-byte scalar / coordinate / hash (`Bytes<32>`). */
const bytes32 = new CompactTypeBytes(32);

/** Descriptor for a Compact `Uint<8>` (1-byte unsigned integer). */
const u8 = new CompactTypeUnsignedInteger(255n, 1);

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
 * The MPC's canonical ECDSA signature as both respond events store it
 * (Compact `Signature`, matching the MPC's own
 * `Signature { big_r, s, recovery_id }` and the EVM/Solana signer
 * contracts): `bigR` the full nonce point so consumers never decompress,
 * `s` big-endian, `recoveryId` the parity of R.y. Stored UNVERIFIED like
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
 * Hand-composed descriptor for {@link MpcSignature}. Leaf order
 * (bigR.x, bigR.y, s, recoveryId) must match the nested Compact structs.
 */
const mpcSignatureType: CompactType<MpcSignature> = {
  /** @returns Compound alignment of the struct's leaves in declaration order. */
  alignment() {
    return bytes32
      .alignment()
      .concat(bytes32.alignment())
      .concat(bytes32.alignment())
      .concat(u8.alignment());
  },
  /**
   * Decode one signature from an aligned value, consuming it leaf by leaf.
   *
   * @param value - Mutable aligned value cursor: pass a copy.
   * @returns The decoded signature.
   */
  fromValue(value) {
    return {
      bigR: { x: bytes32.fromValue(value), y: bytes32.fromValue(value) },
      s: bytes32.fromValue(value),
      recoveryId: u8.fromValue(value),
    };
  },
  /**
   * Encode a signature into its aligned on-ledger representation.
   *
   * @param record - The signature to encode.
   * @returns The aligned value, leaves concatenated in declaration order.
   */
  toValue(record) {
    return bytes32
      .toValue(record.bigR.x)
      .concat(bytes32.toValue(record.bigR.y))
      .concat(bytes32.toValue(record.s))
      .concat(u8.toValue(record.recoveryId));
  },
};

/**
 * The MPC's signature over the requested EVM transaction (Compact
 * `SignatureRespondedEvent`): decode to an ethers signature with
 * `signatureRespondedEventToSignature`. The request id it answers lives in
 * the map key.
 */
export interface SignatureRespondedEvent {
  /** The requested signature over the transaction the request describes. */
  signature: MpcSignature;
}

/**
 * Hand-composed descriptor for {@link SignatureRespondedEvent}: the single
 * {@link MpcSignature} field, matching the Compact struct.
 */
export const signatureRespondedEventType: CompactType<SignatureRespondedEvent> = {
  /** @returns Alignment of the struct's single signature field. */
  alignment() {
    return mpcSignatureType.alignment();
  },
  /**
   * Decode one signature response from an aligned value.
   *
   * @param value - Mutable aligned value cursor: pass a copy.
   * @returns The decoded record.
   */
  fromValue(value) {
    return { signature: mpcSignatureType.fromValue(value) };
  },
  /**
   * Encode a signature response into its aligned on-ledger representation.
   *
   * @param record - The record to encode.
   * @returns The aligned value.
   */
  toValue(record) {
    return mpcSignatureType.toValue(record.signature);
  },
};

/**
 * The MPC's respond-bidirectional attestation of a request's remote EVM
 * execution (Compact `RespondBidirectionalEvent`): the ECDSA signature over
 * the attestation digest `keccak256(requestId || serializedOutput)`. Both the
 * digest and the output travel off chain: readers fetch the output, recompute
 * the digest (`calculateSignetAttestationDigest`) and verify the signature
 * over it. Stored UNVERIFIED by the signet contract, so that signature check
 * against the expected MPC response key is the only thing separating a
 * genuine post from garbage (in-circuit via
 * `verifyRespondBidirectionalEvent`, off chain via
 * {@link verifyRespondBidirectionalSignature}).
 */
export interface RespondBidirectionalEvent {
  /** ECDSA signature over the attestation digest. */
  signature: MpcSignature;
}

/**
 * Composite key of one posted entry in the signet contract's maps (Compact
 * `SignetMapKey`): the request id it belongs to plus the post's 0-based
 * count. Field order (count first, then request id) mirrors the Compact
 * struct.
 */
export interface SignetMapKey {
  /** 0-based position of this post among the entries for {@link requestId}. */
  count: bigint;
  /** 32-byte id of the request this entry belongs to. */
  requestId: RequestId;
}

/**
 * Hand-composed descriptor for {@link SignetMapKey}, the map key of every
 * posted-entry map in the signet contract. Field order (count, then
 * requestId) must match the Compact struct.
 */
export const signetMapKeyType: CompactType<SignetMapKey> = {
  /** @returns Compound alignment of the struct's fields in declaration order. */
  alignment() {
    return u64.alignment().concat(requestIdType.alignment());
  },
  /**
   * Decode one key from an aligned value, consuming it field by field.
   *
   * @param value - Mutable aligned value cursor: pass a copy.
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
 * Hand-composed descriptor for {@link RespondBidirectionalEvent}: the single
 * {@link MpcSignature} field, matching the Compact struct.
 */
export const respondBidirectionalEventType: CompactType<RespondBidirectionalEvent> = {
  /** @returns Alignment of the struct's single signature field. */
  alignment() {
    return mpcSignatureType.alignment();
  },
  /**
   * Decode one response record from an aligned value.
   *
   * @param value - Mutable aligned value cursor: pass a copy.
   * @returns The decoded record.
   */
  fromValue(value) {
    return { signature: mpcSignatureType.fromValue(value) };
  },
  /**
   * Encode a response record into its aligned on-ledger representation.
   *
   * @param record - The record to encode.
   * @returns The aligned value.
   */
  toValue(record) {
    return mpcSignatureType.toValue(record.signature);
  },
};

/** Descriptor for the notification's packed V1 payload (`Bytes<128>`). */
const bytes128Payload = new CompactTypeBytes(128);

/**
 * Raw twin of the Compact `SignBidirectionalEventNotification` struct as
 * stored on-ledger: the version tag plus the still-packed 128-byte payload.
 * Decode the payload with {@link decodeSignBidirectionalNotification}.
 */
export interface SignBidirectionalNotificationRecord {
  /** Payload layout tag (Compact `Uint<8>`): 1 = the V1 layout. */
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
      return u8.alignment().concat(bytes128Payload.alignment());
    },
    /**
     * Decode one notification record from an aligned value, consuming it
     * field by field.
     *
     * @param value - Mutable aligned value cursor: pass a copy.
     * @returns The decoded record.
     */
    fromValue(value) {
      return {
        version: u8.fromValue(value),
        payload: bytes128Payload.fromValue(value),
      };
    },
    /**
     * Encode a notification record into its aligned on-ledger representation.
     *
     * @param record - The record to encode.
     * @returns The aligned value, fields concatenated in declaration order.
     */
    toValue(record) {
      return u8
        .toValue(record.version)
        .concat(bytes128Payload.toValue(record.payload));
    },
  };

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
 * A decoded V1 notification from the signet contract's registry: the flat
 * pointer a client registered to tell the MPC a request was stored, and
 * WHERE to read the authenticated copy. The request id is NOT in the payload:
 * it lives in the registry map key the record was stored under. Never trusted
 * on its own: the resolver authenticates by reading the request back from
 * {@link callerAddress}'s own ledger (see signet-request-resolver.ts).
 */
export interface SignBidirectionalNotification {
  /** Payload layout tag: this decoder only produces version 1. */
  version: number;
  /**
   * Address of the contract whose request map holds the request, rendered
   * as lowercase hex, no `0x` prefix: directly usable as a
   * `queryContractState` argument. The MPC reads the request from THIS
   * contract's authenticated state. The field itself confers no authority.
   */
  callerAddress: string;
  /**
   * Resolved ledger-tree path of the `SignBidirectionalEventMap` in
   * {@link callerAddress}, as compactc records it in that contract's
   * `contract-info.json` (`"index"`): `[4]` for a flat contract's field 4,
   * `[1, 14]` once chunking applies. The reader follows it node for node
   * (see {@link signetFieldNodeByPath}) and never assumes a layout.
   */
  requestsPath: number[];
}

/**
 * Unpack a stored {@link SignBidirectionalNotificationRecord}'s payload by
 * the fixed V1 offsets: the decode twin of the compiled
 * `constructSignBidirectionalEventNotificationV1` circuit (byte plumbing
 * only: the pack↔decode lockstep is pinned by the state-reader unit test that
 * round-trips through the real circuit). V1 layout:
 * callerAddress (32) ++ requestsPathDepth (1) ++ requestsPath (4) ++ zero
 * padding (91), where only the first `requestsPathDepth` path bytes are
 * meaningful.
 *
 * Fails closed on an unrecognised `version`: a future payload layout adds a
 * branch here rather than silently misinterpreting bytes under the V1 offsets.
 *
 * @param record - The raw on-ledger record.
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

/**
 * Plain-JS notification registry parsed out of the ledger: hex request id
 * (from the `SignetMapKey` the notification was stored under) to the raw
 * stored record. Re-notifies append under higher counts. This index keeps
 * the FIRST post (count 0) per request id, the record the original submit
 * registered. Decode each record with
 * {@link decodeSignBidirectionalNotification}.
 */
export type SignBidirectionalNotificationIndex = Map<
  RequestIdHex,
  SignBidirectionalNotificationRecord
>;

/**
 * Plain-JS counter map parsed out of the ledger: hex request id (see
 * {@link requestIdHex}) to the number of entries posted for that request.
 * Entries in the corresponding map exist for counts `0 .. value - 1`.
 */
export type SignetCounterIndex = Map<RequestIdHex, bigint>;

/**
 * Plain-JS signature response log parsed out of the ledger, keyed by
 * {@link signetMapEntryKey} (`"<hexRequestId>:<count>"`) so the composite
 * Compact key survives as a usable JS `Map` key.
 */
export type SignatureResponseIndex = Map<string, SignatureRespondedEvent>;

/**
 * Plain-JS respond-bidirectional log parsed out of the ledger, keyed by
 * {@link signetMapEntryKey} (`"<hexRequestId>:<count>"`).
 */
export type RespondBidirectionalIndex = Map<string, RespondBidirectionalEvent>;

/**
 * Build the flattened JS map key for a `(requestId, count)` pair: the
 * composite Compact {@link SignetMapKey} as a string so it works as a JS
 * `Map` key.
 *
 * @param id - The request id the entry belongs to, in canonical hex form.
 * @param count - 0-based post count within that request.
 * @returns `"<hexRequestId>:<count>"`.
 */
export function signetMapEntryKey(id: RequestIdHex, count: bigint): string {
  return `${id}:${count}`;
}

/** Decode a `Map<RequestId, Counter>` ledger field into a {@link SignetCounterIndex}. */
function readCounterMap(raw: RawContractState, field: number): SignetCounterIndex {
  // The central singleton is flat (6 fields), so a field number is a depth-1 path.
  const counterMap = signetFieldNodeByPath(raw, [field]).asMap();
  if (counterMap === undefined) {
    throw new Error(`Ledger field ${field} is not a Map`);
  }
  const index: SignetCounterIndex = new Map();
  for (const key of counterMap.keys()) {
    // fromValue consumes its input, so hand each descriptor a copy.
    const requestId = requestIdType.fromValue([...key.value]);
    // A Counter is stored as a plain u64 cell.
    const cell = counterMap.get(key)?.asCell();
    if (cell === undefined) continue;
    index.set(requestIdHex(requestId), u64.fromValue([...cell.value]));
  }
  return index;
}

/** Decode a `Map<SignetMapKey, T>` ledger field into a string-keyed JS map. */
function readSignetKeyedMap<T>(
  raw: RawContractState,
  field: number,
  valueType: CompactType<T>,
): Map<string, T> {
  const map = signetFieldNodeByPath(raw, [field]).asMap();
  if (map === undefined) {
    throw new Error(`Ledger field ${field} is not a Map`);
  }
  const index = new Map<string, T>();
  for (const key of map.keys()) {
    const mapKey = signetMapKeyType.fromValue([...key.value]);
    const cell = map.get(key)?.asCell();
    if (cell === undefined) continue;
    index.set(
      signetMapEntryKey(requestIdHex(mapKey.requestId), mapKey.count),
      valueType.fromValue([...cell.value]),
    );
  }
  return index;
}

/**
 * Read ONLY the notification registry (ledger field
 * {@link SIGN_BIDIRECTIONAL_EVENT_NOTIFICATION_MAP_FIELD}) out of raw signet
 * contract state: the poll-loop primitive of {@link SignetRequestFeed},
 * which cycles frequently and has no use for the response fields. One record
 * per request id (the count-0 post, see
 * {@link SignBidirectionalNotificationIndex}).
 *
 * @param raw - Raw contract state, e.g. `queryContractState(address).data`
 *   from the indexer or `ctx.currentQueryContext.state` from the simulator.
 * @returns The registry, keyed by the hex request id of each entry's map key.
 * @throws Error if the field is missing or is not a Map.
 */
export function readSignBidirectionalNotificationIndexFromState(
  raw: RawContractState,
): SignBidirectionalNotificationIndex {
  const notificationMap = signetFieldNodeByPath(raw, [
    SIGN_BIDIRECTIONAL_EVENT_NOTIFICATION_MAP_FIELD,
  ]).asMap();
  if (notificationMap === undefined) {
    throw new Error(
      `Ledger field ${SIGN_BIDIRECTIONAL_EVENT_NOTIFICATION_MAP_FIELD} is not a Map`,
    );
  }
  const index: SignBidirectionalNotificationIndex = new Map();
  const counts = new Map<RequestIdHex, bigint>();
  for (const key of notificationMap.keys()) {
    // fromValue consumes its input, so hand each descriptor a copy.
    const mapKey = signetMapKeyType.fromValue([...key.value]);
    const cell = notificationMap.get(key)?.asCell();
    if (cell === undefined) continue;
    const id = requestIdHex(mapKey.requestId);
    const seen = counts.get(id);
    // Keep the FIRST post (lowest count) per request id.
    if (seen !== undefined && seen <= mapKey.count) continue;
    counts.set(id, mapKey.count);
    index.set(id, signBidirectionalNotificationType.fromValue([...cell.value]));
  }
  return index;
}

/**
 * The decoded ledger fields of the signet contract: the three
 * (counter map, entry map) pairs, namely notifications (fields 0/1), signature
 * responses (fields 2/3), respond-bidirectional responses (fields 4/5).
 * Together they give a poller everything the contract ever records about a
 * request. All entries are UNAUTHENTICATED: verify before trusting.
 */
export interface SignetContractLedger {
  /** Notification post counts per request id (ledger field 0). */
  signBidirectionalEventNotificationCounterMap: SignetCounterIndex;
  /**
   * The notification registry (ledger field 1), one record per request id
   * (count-0 post).
   */
  signBidirectionalEventNotificationMap: SignBidirectionalNotificationIndex;
  /** `respond` post counts per request id (ledger field 2). */
  respondCounterMap: SignetCounterIndex;
  /** The `respond` post log (ledger field 3), keyed by {@link signetMapEntryKey}. */
  respondMap: SignatureResponseIndex;
  /** Respond-bidirectional post counts per request id (ledger field 4). */
  respondBidirectionalCounterMap: SignetCounterIndex;
  /** The respond-bidirectional log (ledger field 5), keyed by {@link signetMapEntryKey}. */
  respondBidirectionalMap: RespondBidirectionalIndex;
}

/**
 * MPC-/client-style read: parse the signet contract's ledger fields out of
 * raw contract state by field position alone, with no compiled contract and
 * no generated `ledger()`, only the declaration-order layout and the
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
  return {
    signBidirectionalEventNotificationCounterMap: readCounterMap(
      raw,
      SIGN_BIDIRECTIONAL_EVENT_NOTIFICATION_COUNTER_MAP_FIELD,
    ),
    signBidirectionalEventNotificationMap:
      readSignBidirectionalNotificationIndexFromState(raw),
    respondCounterMap: readCounterMap(
      raw,
      RESPOND_COUNTER_MAP_FIELD,
    ),
    respondMap: readSignetKeyedMap(
      raw,
      RESPOND_MAP_FIELD,
      signatureRespondedEventType,
    ),
    respondBidirectionalCounterMap: readCounterMap(
      raw,
      RESPOND_BIDIRECTIONAL_COUNTER_MAP_FIELD,
    ),
    respondBidirectionalMap: readSignetKeyedMap(
      raw,
      RESPOND_BIDIRECTIONAL_MAP_FIELD,
      respondBidirectionalEventType,
    ),
  };
}
