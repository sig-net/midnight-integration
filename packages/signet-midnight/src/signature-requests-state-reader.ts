// MPC-style raw state reader for the signature-REQUESTS side: decode the signet
// request ledger fields out of a contract's raw state WITHOUT the compiled
// contract. This is how the MPC monitor consumes signet contracts — it has only
// a contract address, queries raw state from the indexer
// (queryContractState(address).data), and decodes by ledger field POSITION.
// A contract is free to place its request index at any field: the caller
// supplies the position, which the discovery path learns from the
// notification's requestsIndexField.
// The compiled contract's generated ledger() does exactly this walk internally;
// the record descriptors themselves are the parameterized twins in
// signet-requests.ts. The generic tree walk and shared base descriptors live
// in signature-state-reading.ts.

import type { CompactType } from "@midnight-ntwrk/compact-runtime";

import {
  requestIdHex,
  signBidirectionalRequestDescriptor,
  type RequestIdHex,
  type SignBidirectionalRequest,
  type SignBidirectionalRequestIndex,
} from "./signet-requests.ts";

/** The aligned-value cursor every descriptor's `fromValue` consumes. */
type AlignedValue = Parameters<CompactType<unknown>["fromValue"]>[0];

import {
  requestIdType,
  signetFieldNode,
  u64,
  type RawContractState,
} from "./signature-state-reading.ts";

/**
 * Aligned-value entry count of a request record EXCLUDING the capacity-scaled
 * vectors: requestNonce (1) + txParamType (1, enums are one atom whatever
 * their byte width) + the EVMType2TxParams fixed fields (to..value = 7,
 * accessListEntryCount = 1) + the calldata Maybe's is_some (1), selector (1)
 * and noWords (1) + the routing fields caip2Id..respondSerializationSchema (8).
 * A stored request cell therefore holds
 *   `REQUEST_FIXED_VALUE_ATOMS + maxCalldataWords
 *      + maxAccessListEntries·(2 + maxStorageKeysPerEntry)`
 * entries (each calldata word is one Bytes<32> atom; each access-list entry is
 * address + storageKeyCount + its keys).
 */
export const REQUEST_FIXED_VALUE_ATOMS = 21;

/**
 * Recover a record's capacity instantiation (maxCalldataWords,
 * maxAccessListEntries, maxStorageKeysPerEntry) from its aligned-value atom
 * count and decode it. Unlike the old single-vector layout, one atom count no
 * longer determines the capacities uniquely, so candidates are enumerated —
 * access-list-free first (today's producers — the caller contract <1, 0, 0>,
 * the erc20-vault example <2, 0, 0> — all are) —
 * and validated by the decode itself: the descriptors' Bytes length checks
 * and the enum range check reject wrong splits, and a decode that leaves
 * atoms unconsumed is rejected here.
 *
 * @param atoms - The record cell's aligned value (a fresh copy per attempt).
 * @returns The decoded record.
 * @throws Error if no capacity split decodes the value cleanly.
 */
function decodeSignBidirectionalRequest(
  atoms: AlignedValue,
): SignBidirectionalRequest {
  const variable = atoms.length - REQUEST_FIXED_VALUE_ATOMS;
  if (variable < 0) {
    throw new Error(
      `request record has ${atoms.length} value entries — fewer than the ` +
        `${REQUEST_FIXED_VALUE_ATOMS} its fixed fields need`,
    );
  }
  const attempt = (
    maxWords: number,
    maxEntries: number,
    maxKeys: number,
  ): SignBidirectionalRequest | undefined => {
    const cursor = [...atoms] as AlignedValue;
    try {
      const record = signBidirectionalRequestDescriptor(
        maxWords,
        maxEntries,
        maxKeys,
      ).fromValue(cursor);
      // A clean decode consumes the record exactly.
      return cursor.length === 0 ? record : undefined;
    } catch {
      return undefined;
    }
  };
  // No access list: variable atoms are calldata words alone (one atom each).
  {
    const record = attempt(variable, 0, 0);
    if (record !== undefined) return record;
  }
  // With an access list: E entries of (2 + K) atoms, the rest words.
  for (let entries = 1; entries * 2 <= variable; entries++) {
    for (let keys = 0; entries * (2 + keys) <= variable; keys++) {
      const words = variable - entries * (2 + keys);
      const record = attempt(words, entries, keys);
      if (record !== undefined) return record;
    }
  }
  throw new Error(
    `request record with ${atoms.length} value entries matches no ` +
      `(calldata words, access-list entries, storage keys) capacity split`,
  );
}

/**
 * The decoded signet ledger fields of a requesting contract: its request
 * index and its contract-local request counter (Compact `SignetNonce`, the
 * source of each request's `requestNonce` — nothing off-chain depends on it,
 * it is decoded here only because both fields travel together in tests and
 * diagnostics).
 */
export interface SignetRequestsLedger {
  /** The request counter (`SignetNonce`). */
  nonce: bigint;
  /** The request index, keyed by hex request id. */
  requestsIndex: SignBidirectionalRequestIndex;
}

/**
 * MPC-style read: parse the signet ledger fields out of raw contract state
 * by field position alone — no compiled contract, no generated `ledger()`,
 * only the caller-supplied field positions and the canonical descriptors
 * from signet-requests.ts. A contract chooses its own layout, so the caller
 * must know where the fields sit (the caller contract in this repo uses
 * index 0 / counter 1; a notification names the index position of the
 * contract it points at).
 *
 * @param raw - Raw contract state, e.g. `queryContractState(address).data`
 *   from the indexer or `ctx.currentQueryContext.state` from the simulator.
 * @param requestsIndexField - Ledger field position of the request index.
 * @param nonceField - Ledger field position of the request counter.
 * @returns The decoded {@link SignetRequestsLedger}.
 * @throws Error if a field is missing, has the wrong state-value shape, or a
 *   record matches no capacity split.
 */
export function readSignetRequestsLedgerFromState(
  raw: RawContractState,
  requestsIndexField: number,
  nonceField: number,
): SignetRequestsLedger {
  const map = signetFieldNode(raw, requestsIndexField).asMap();
  if (map === undefined) {
    throw new Error(`Ledger field ${requestsIndexField} is not a Map`);
  }
  const requestsIndex: SignBidirectionalRequestIndex = new Map();
  for (const key of map.keys()) {
    // fromValue consumes its input, so hand each descriptor a copy.
    const requestId = requestIdType.fromValue([...key.value]);
    const cell = map.get(key)?.asCell();
    if (cell === undefined) continue;
    requestsIndex.set(
      requestIdHex(requestId),
      decodeSignBidirectionalRequest(cell.value),
    );
  }

  const nonceCell = signetFieldNode(raw, nonceField).asCell();
  if (nonceCell === undefined) {
    throw new Error(`Ledger field ${nonceField} is not a Cell`);
  }
  const nonce = u64.fromValue([...nonceCell.value]);

  return { nonce, requestsIndex };
}

/**
 * Look up ONE request by id in a contract's request index at an arbitrary
 * ledger field — the single-record sibling of
 * {@link readSignetRequestsLedgerFromState}, and what the discovery path
 * uses: a notification names both the requester contract AND which field
 * holds its index.
 *
 * This is the mandatory membership check of the discovery flow (see
 * signet-request-resolver.ts): `undefined` means the id is NOT a member of the
 * index at `fieldIndex` — the notification is forged, stale, points at the
 * wrong field, or the request is not yet indexed — and the caller MUST drop it.
 * Every non-membership case (field out of range, field is not a Map, id absent,
 * a cell that fails to decode) returns `undefined` rather than throwing, so a
 * malformed or adversarial notification can never crash the reader.
 *
 * Only the matched record is decoded (not the whole index), and it is decoded
 * by the same {@link decodeSignBidirectionalRequest} the full reader uses, so
 * the result is `toEqual` to `readSignetRequestsLedgerFromState(raw,
 * fieldIndex, …).requestsIndex.get(requestId)`.
 *
 * @param raw - Raw contract state, e.g. `queryContractState(address).data`.
 * @param fieldIndex - Ledger field position of the request index in `raw`.
 * @param requestId - The request id to look up.
 * @returns The stored request record, or `undefined` when it is not a member.
 */
export function lookupSignetRequestAt(
  raw: RawContractState,
  fieldIndex: number,
  requestId: RequestIdHex,
): SignBidirectionalRequest | undefined {
  let node;
  try {
    node = signetFieldNode(raw, fieldIndex);
  } catch {
    return undefined; // field position out of range for this contract
  }
  const map = node.asMap();
  if (map === undefined) {
    return undefined; // the named field is not a request index
  }
  for (const key of map.keys()) {
    // fromValue consumes its input, so hand each descriptor a copy.
    if (requestIdHex(requestIdType.fromValue([...key.value])) !== requestId) {
      continue;
    }
    const cell = map.get(key)?.asCell();
    if (cell === undefined) {
      return undefined;
    }
    try {
      return decodeSignBidirectionalRequest(cell.value);
    } catch {
      return undefined; // a cell that is not a decodable request record
    }
  }
  return undefined; // id absent from the index
}
