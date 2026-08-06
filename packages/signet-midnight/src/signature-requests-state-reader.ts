// MPC-style raw state reader for the signature-REQUESTS side: decode the
// signet request ledger fields out of a contract's raw state by resolved
// ledger-tree path, as the MPC monitor and the event feed consume signet
// contracts. The record descriptors are the parameterised twins in
// signet-requests.ts. The generic tree walk and shared base descriptors live
// in signature-state-reading.ts.

import type { CompactType } from "@midnight-ntwrk/compact-runtime";

import {
  calculateRequestId,
  signBidirectionalEventDescriptor,
} from "./signet-evtype2tx-requests.ts";
import {
  requestIdHex,
  type RequestIdHex,
  type SignBidirectionalEvent,
  type SignBidirectionalEventIndex,
} from "./signet-requests.ts";

/** The aligned-value cursor every descriptor's `fromValue` consumes. */
type AlignedValue = Parameters<CompactType<unknown>["fromValue"]>[0];

import {
  requestIdType,
  signetFieldNodeByPath,
  u64,
  type RawContractState,
} from "./signature-state-reading.ts";

/**
 * Aligned-value entry count of an event record EXCLUDING the capacity-scaled
 * vectors, in lockstep with the `SignBidirectionalEvent` struct's fixed
 * fields. A stored event cell holds
 *   `REQUEST_FIXED_VALUE_ATOMS + maxCalldataWords
 *      + maxAccessListEntries * (2 + maxStorageKeysPerEntry)`
 * entries.
 */
export const REQUEST_FIXED_VALUE_ATOMS = 22;

/**
 * Recover a record's capacity instantiation (maxCalldataWords,
 * maxAccessListEntries, maxStorageKeysPerEntry) from its aligned-value atom
 * count and decode it. The schema byte widths are read from the LAST TWO
 * atoms' actual byte lengths, relying on the protocol convention that
 * schemas are exact-length (never NUL-padded, never ending in a zero byte).
 *
 * @param atoms - The record cell's aligned value (a fresh copy per attempt).
 * @param expectedRequestId - The id the record is stored under, used to pick
 *   between splits when more than one decodes cleanly.
 * @returns The decoded record.
 * @throws Error if no capacity split decodes the value cleanly.
 */
function decodeSignBidirectionalEvent(
  atoms: AlignedValue,
  expectedRequestId: RequestIdHex,
): SignBidirectionalEvent {
  const variable = atoms.length - REQUEST_FIXED_VALUE_ATOMS;
  if (variable < 0) {
    throw new Error(
      `request record has ${atoms.length} value entries: fewer than the ` +
        `${REQUEST_FIXED_VALUE_ATOMS} its fixed fields need`,
    );
  }
  const lenOutputDeserialization = (atoms[atoms.length - 2] as Uint8Array).length;
  const lenRespondSerialization = (atoms[atoms.length - 1] as Uint8Array).length;
  const attempt = (
    maxWords: number,
    maxEntries: number,
    maxKeys: number,
  ): SignBidirectionalEvent | undefined => {
    const cursor = [...atoms] as AlignedValue;
    try {
      const record = signBidirectionalEventDescriptor(
        maxWords,
        maxEntries,
        maxKeys,
        lenOutputDeserialization,
        lenRespondSerialization,
      ).fromValue(cursor);
      // A clean decode consumes the record exactly.
      return cursor.length === 0 ? record : undefined;
    } catch {
      return undefined;
    }
  };
  // Several splits can decode cleanly (an access-list entry's 20-byte address atom
  // re-pads into a 32-byte calldata word just as well), so only the id the record is
  // filed under separates them. This disambiguates but does not authenticate (the MPC
  // recomputes against the sender-bound id before signing).
  //
  // First match wins, so the common access-list-free case stays at one decode.
  // `fallback` preserves the pre-recompute behaviour when no split matches the id.
  let fallback: SignBidirectionalEvent | undefined;
  const take = (record: SignBidirectionalEvent | undefined): boolean => {
    if (record === undefined) return false;
    fallback ??= record;
    return requestIdHex(calculateRequestId(record)) === expectedRequestId;
  };
  // No access list: variable atoms are calldata words alone (one atom each).
  const accessListFree = attempt(variable, 0, 0);
  if (take(accessListFree)) return accessListFree!;
  // With an access list: E entries of (2 + K) atoms, the rest words.
  for (let entries = 1; entries * 2 <= variable; entries++) {
    for (let keys = 0; entries * (2 + keys) <= variable; keys++) {
      const words = variable - entries * (2 + keys);
      const record = attempt(words, entries, keys);
      if (take(record)) return record!;
    }
  }
  if (fallback === undefined) {
    throw new Error(
      `request record with ${atoms.length} value entries matches no ` +
        `(calldata words, access-list entries, storage keys) capacity split`,
    );
  }
  return fallback;
}

/**
 * The decoded signet ledger fields of a requesting contract: its request
 * index and its contract-local request counter (Compact `Counter`), the
 * source of each request's `requestNonce`.
 */
export interface SignetRequestsLedger {
  /** The request counter (`Counter`). */
  nonce: bigint;
  /** The request index, keyed by hex request id. */
  requestsIndex: SignBidirectionalEventIndex;
}

/**
 * MPC-style read: parse the signet ledger fields out of raw contract state
 * by caller-supplied field positions. A contract chooses its own layout, so
 * the caller must know where the fields sit.
 *
 * @param raw - Raw contract state, e.g. `queryContractState(address).data`
 *   from the indexer or `ctx.currentQueryContext.state` from the simulator.
 * @param requestsIndexPath - Resolved ledger-tree path of the request index.
 * @param noncePath - Resolved ledger-tree path of the request counter.
 * @returns The decoded {@link SignetRequestsLedger}.
 * @throws Error if a field is missing, has the wrong state-value shape, or a
 *   record matches no capacity split.
 */
export function readSignetRequestsLedgerFromState(
  raw: RawContractState,
  requestsIndexPath: readonly number[],
  noncePath: readonly number[],
): SignetRequestsLedger {
  const map = signetFieldNodeByPath(raw, requestsIndexPath).asMap();
  if (map === undefined) {
    throw new Error(`Ledger field at path ${JSON.stringify(requestsIndexPath)} is not a Map`);
  }
  const requestsIndex: SignBidirectionalEventIndex = new Map();
  for (const key of map.keys()) {
    // fromValue consumes its input, so hand each descriptor a copy.
    const requestId = requestIdHex(requestIdType.fromValue([...key.value]));
    const cell = map.get(key)?.asCell();
    if (cell === undefined) continue;
    requestsIndex.set(requestId, decodeSignBidirectionalEvent(cell.value, requestId));
  }

  const nonceCell = signetFieldNodeByPath(raw, noncePath).asCell();
  if (nonceCell === undefined) {
    throw new Error(`Ledger field at path ${JSON.stringify(noncePath)} is not a Cell`);
  }
  const nonce = u64.fromValue([...nonceCell.value]);

  return { nonce, requestsIndex };
}

/**
 * Look up ONE request by id in a contract's request index at an arbitrary
 * ledger field: the single-record sibling of
 * {@link readSignetRequestsLedgerFromState} and the discovery primitive of
 * the event-based feed. Every non-membership case returns `undefined`
 * rather than throwing, and the caller MUST drop such a pointer.
 *
 * @param raw - Raw contract state, e.g. `queryContractState(address).data`.
 * @param requestsPath - Resolved ledger-tree path of the request index in
 *   `raw`, as the notification carries it.
 * @param requestId - The request id to look up.
 * @returns The stored request record, or `undefined` when it is not a member.
 */
export function lookupSignetRequestAt(
  raw: RawContractState,
  requestsPath: readonly number[],
  requestId: RequestIdHex,
): SignBidirectionalEvent | undefined {
  let node;
  try {
    node = signetFieldNodeByPath(raw, requestsPath);
  } catch {
    return undefined; // path out of range for this contract
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
      return decodeSignBidirectionalEvent(cell.value, requestId);
    } catch {
      return undefined; // a cell that is not a decodable request record
    }
  }
  return undefined; // id absent from the index
}
