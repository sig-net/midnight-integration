// MPC-/client-style raw state reader for the signature-RESPONSES contract:
// decode its ledger fields out of a contract's raw state WITHOUT the compiled
// contract, the mirror image of signature-requests-state-reader.ts. A poller
// has only the contract address, queries raw state from the indexer
// (queryContractState(address).data), and decodes by the signet response
// layout convention: the per-request counter index is ledger field 0, the
// response log field 1 (see "Response Ledger Layout" in Signet.compact). The
// generic state-tree walk (RawContractState, signetFieldNode) and the shared
// base descriptors live in signature-state-reading.ts.

import {
  CompactTypeBytes,
  type CompactType,
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

/** Signet response layout convention: the counter index is ledger field 0. */
export const SIGNATURE_RESPONSE_COUNTER_INDEX_FIELD = 0;

/** Signet response layout convention: the response log is ledger field 1. */
export const SIGNATURE_RESPONSE_INDEX_FIELD = 1;

// ---- Type descriptors (must mirror Signet.compact field-for-field) ----
// As in the requests reader, fromValue consumes the aligned value
// sequentially, so field order and width here must match the Compact structs
// exactly — a mismatch is silent data corruption, not an error.

/** Descriptor for one response value (Compact `SignetEVMSignatureResponse`, a `Bytes<65>`). */
const bytes65 = new CompactTypeBytes(65);

/**
 * The raw 65-byte `r || s || v` MPC signature over the requested EVM
 * transaction (Compact `SignetEVMSignatureResponse`, a nominal `Bytes<65>`).
 * The request id it answers lives in the response index key, not here.
 */
export type SignetEVMSignatureResponse = Uint8Array;

/**
 * Composite key of one posted response (Compact `SignatureResponseKey`): the
 * request id it answers plus this post's 0-based count. Field order — count
 * first, then request id — mirrors the Compact struct.
 */
export interface SignatureResponseKey {
  /** 0-based position of this post among the responses for {@link requestId}. */
  count: bigint;
  /** 32-byte id of the request this response answers. */
  requestId: SignetRequestId;
}

/**
 * Hand-composed descriptor for {@link SignatureResponseKey} — the map key of
 * the response index. Field order (count, then requestId) must match the
 * Compact struct.
 */
export const signatureResponseKeyType: CompactType<SignatureResponseKey> = {
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
 * Plain-JS counter index parsed out of the ledger: hex request id (see
 * {@link requestIdHex}) to the number of responses posted for that request.
 * Entries in the response log exist for counts `0 .. value - 1`.
 */
export type SignatureResponseCounterIndex = Map<SignetRequestIdHex, bigint>;

/**
 * Plain-JS response log parsed out of the ledger, keyed by
 * {@link signatureResponseIndexKey} (`"<hexRequestId>:<count>"`) so the
 * composite Compact key survives as a usable JS `Map` key.
 */
export type SignatureResponseIndex = Map<string, SignetEVMSignatureResponse>;

/**
 * Build the {@link SignatureResponseIndex} key for a `(requestId, count)`
 * pair — the composite Compact key flattened to a string so it works as a JS
 * `Map` key.
 *
 * @param id - The request id the response answers, in canonical hex form.
 * @param count - 0-based post count within that request.
 * @returns `"<hexRequestId>:<count>"`.
 */
export function signatureResponseIndexKey(
  id: SignetRequestIdHex,
  count: bigint,
): string {
  return `${id}:${count}`;
}

/**
 * The decoded ledger fields of the signature-responses contract: the
 * per-request post counter (field 0) and the response log (field 1). Together
 * they let a client enumerate every posted response for a request and verify
 * the signatures off-chain.
 */
export interface SignetResponsesLedger {
  /**
   * The counter index (ledger field
   * {@link SIGNATURE_RESPONSE_COUNTER_INDEX_FIELD}), keyed by hex request id.
   */
  signatureResponseCounterIndex: SignatureResponseCounterIndex;
  /**
   * The response log (ledger field {@link SIGNATURE_RESPONSE_INDEX_FIELD}),
   * keyed by {@link signatureResponseIndexKey}.
   */
  signatureResponseIndex: SignatureResponseIndex;
}

/**
 * MPC-/client-style read: parse the signature-responses ledger fields out of
 * raw contract state by field position alone — no compiled contract, no
 * generated `ledger()`, only the signet response layout convention and the
 * canonical descriptors above.
 *
 * @param raw - Raw contract state, e.g. `queryContractState(address).data`
 *   from the indexer or `ctx.currentQueryContext.state` from the simulator.
 * @returns The decoded {@link SignetResponsesLedger}.
 * @throws Error if a field is missing or has the wrong state-value shape.
 */
export function readSignetResponsesLedgerFromState(
  raw: RawContractState,
): SignetResponsesLedger {
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
    const responseKey = signatureResponseKeyType.fromValue([...key.value]);
    const cell = responseMap.get(key)?.asCell();
    if (cell === undefined) continue;
    signatureResponseIndex.set(
      signatureResponseIndexKey(requestIdHex(responseKey.requestId), responseKey.count),
      bytes65.fromValue([...cell.value]),
    );
  }

  return { signatureResponseCounterIndex, signatureResponseIndex };
}
