// MPC-/client-style raw state reader for the central SIGNET contract: decode
// its ledger fields out of a contract's raw state WITHOUT the compiled
// contract, the mirror image of signature-requests-state-reader.ts. A poller
// has only the contract address, queries raw state from the indexer
// (queryContractState(address).data), and decodes by the signet contract
// layout convention (see "Signet Contract Ledger Layout" in Signet.compact):
// signature response counter index (field 0), signature response log
// (field 1), remote execution response index (field 2), sealed MPC key hash
// (field 3). The generic state-tree walk (RawContractState, signetFieldNode)
// and the shared base descriptors live in signature-state-reading.ts.

import {
  CompactTypeBytes,
  CompactTypeField,
  CompactTypeJubjubPoint,
  type CompactType,
  type JubjubPoint,
} from "@midnight-ntwrk/compact-runtime";

import {
  requestIdHex,
  type SignetRequestId,
  type SignetRequestIdHex,
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

/** Signet contract layout: the remote execution response index is ledger field 2. */
export const REMOTE_EXECUTION_RESPONSE_INDEX_FIELD = 2;

/** Signet contract layout: the sealed MPC attestation key hash is ledger field 3. */
export const MPC_PUB_KEY_HASH_FIELD = 3;

// ---- Type descriptors (must mirror Signet.compact field-for-field) ----
// As in the requests reader, fromValue consumes the aligned value
// sequentially, so field order and width here must match the Compact structs
// exactly — a mismatch is silent data corruption, not an error.

/** Descriptor for one signature response (Compact `SignetEVMSignatureResponse`, a `Bytes<65>`). */
const bytes65 = new CompactTypeBytes(65);

/** Descriptor for the attestation's output data (`Bytes<4096>`). */
const bytes4096 = new CompactTypeBytes(4096);

/** Descriptor for the sealed MPC key hash (`Bytes<32>`). */
const bytes32 = new CompactTypeBytes(32);

/**
 * The raw 65-byte `r || s || v` MPC signature over the requested EVM
 * transaction (Compact `SignetEVMSignatureResponse`, a nominal `Bytes<65>`).
 * The request id it answers lives in the response index key, not here.
 */
export type SignetEVMSignatureResponse = Uint8Array;

/**
 * The MPC's attestation of a request's remote EVM execution (Compact
 * `SignetRemoteExecutionResponse`): the full output data plus the Schnorr
 * signature over `(requestId, hash(outputData))`. Stored records were
 * verified IN-CIRCUIT by the signet contract at post time, so readers can
 * trust them without re-verifying.
 */
export interface SignetRemoteExecutionResponse {
  /** Full ABI-encoded return data, zero-padded to 4096 bytes. */
  outputData: Uint8Array;
  /** The MPC attestation key (hash-checked against the sealed key at post). */
  pk: JubjubPoint;
  /** Schnorr nonce commitment R. */
  announcement: JubjubPoint;
  /** Schnorr response scalar s. */
  response: bigint;
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
  requestId: SignetRequestId;
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
 * Hand-composed descriptor for {@link SignetRemoteExecutionResponse}. Field
 * order (outputData, pk, announcement, response) must match the Compact
 * struct.
 */
export const signetRemoteExecutionResponseType: CompactType<SignetRemoteExecutionResponse> = {
  /** @returns Compound alignment of the struct's fields in declaration order. */
  alignment() {
    return bytes4096
      .alignment()
      .concat(CompactTypeJubjubPoint.alignment())
      .concat(CompactTypeJubjubPoint.alignment())
      .concat(CompactTypeField.alignment());
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
      outputData: bytes4096.fromValue(value),
      pk: CompactTypeJubjubPoint.fromValue(value),
      announcement: CompactTypeJubjubPoint.fromValue(value),
      response: CompactTypeField.fromValue(value),
    };
  },
  /**
   * Encode an attestation record into its aligned on-ledger representation.
   *
   * @param record - The record to encode.
   * @returns The aligned value, fields concatenated in declaration order.
   */
  toValue(record) {
    return bytes4096
      .toValue(record.outputData)
      .concat(CompactTypeJubjubPoint.toValue(record.pk))
      .concat(CompactTypeJubjubPoint.toValue(record.announcement))
      .concat(CompactTypeField.toValue(record.response));
  },
};

/**
 * Plain-JS signature response counter index parsed out of the ledger: hex
 * request id (see {@link requestIdHex}) to the number of responses posted for
 * that request. Entries in the response log exist for counts `0 .. value - 1`.
 */
export type SignatureResponseCounterIndex = Map<SignetRequestIdHex, bigint>;

/**
 * Plain-JS signature response log parsed out of the ledger, keyed by
 * {@link signetResponseIndexKey} (`"<hexRequestId>:<count>"`) so the
 * composite Compact key survives as a usable JS `Map` key.
 */
export type SignatureResponseIndex = Map<string, SignetEVMSignatureResponse>;

/**
 * Plain-JS remote execution response index parsed out of the ledger: hex
 * request id to the contract-verified attestation. One slot per request.
 */
export type RemoteExecutionResponseIndex = Map<
  SignetRequestIdHex,
  SignetRemoteExecutionResponse
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
  id: SignetRequestIdHex,
  count: bigint,
): string {
  return `${id}:${count}`;
}

/**
 * The decoded ledger fields of the signet contract: the signature response
 * counter (field 0) and log (field 1), the remote execution response index
 * (field 2), and the sealed MPC attestation key hash (field 3). Together
 * they give a client everything the MPC ever delivers for a request.
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
   * The remote execution response index (ledger field
   * {@link REMOTE_EXECUTION_RESPONSE_INDEX_FIELD}), keyed by hex request id.
   */
  remoteExecutionResponseIndex: RemoteExecutionResponseIndex;
  /**
   * The sealed MPC attestation key hash (ledger field
   * {@link MPC_PUB_KEY_HASH_FIELD}) posts are verified against.
   */
  mpcPubKeyHash: Uint8Array;
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
      bytes65.fromValue([...cell.value]),
    );
  }

  const executionMap = signetFieldNode(
    raw,
    REMOTE_EXECUTION_RESPONSE_INDEX_FIELD,
  ).asMap();
  if (executionMap === undefined) {
    throw new Error(
      `Ledger field ${REMOTE_EXECUTION_RESPONSE_INDEX_FIELD} is not a Map`,
    );
  }
  const remoteExecutionResponseIndex: RemoteExecutionResponseIndex = new Map();
  for (const key of executionMap.keys()) {
    const requestId = requestIdType.fromValue([...key.value]);
    const cell = executionMap.get(key)?.asCell();
    if (cell === undefined) continue;
    remoteExecutionResponseIndex.set(
      requestIdHex(requestId),
      signetRemoteExecutionResponseType.fromValue([...cell.value]),
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
    remoteExecutionResponseIndex,
    mpcPubKeyHash,
  };
}
