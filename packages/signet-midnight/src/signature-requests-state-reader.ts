// MPC-style raw state reader for the signature-REQUESTS side: decode the signet
// request ledger fields out of a contract's raw state WITHOUT the compiled
// contract. This is how the MPC monitor consumes signet contracts — it has only
// a contract address, queries raw state from the indexer
// (queryContractState(address).data), and decodes by the signet layout
// convention: the request index is ledger field 0, the request counter field 1.
// The compiled contract's generated ledger() does exactly this walk internally;
// the record descriptors themselves are the parameterized twins in
// signet-requests.ts. The generic tree walk and shared base descriptors live
// in signature-state-reading.ts.

import type { CompactType } from "@midnight-ntwrk/compact-runtime";

import {
  requestIdHex,
  signBidirectionalEventDescriptor,
  type SignBidirectionalEvent,
  type SignBidirectionalEventIndex,
} from "./signet-requests.ts";

/** The aligned-value cursor every descriptor's `fromValue` consumes. */
type AlignedValue = Parameters<CompactType<unknown>["fromValue"]>[0];

import {
  requestIdType,
  signetFieldNode,
  u64,
  type RawContractState,
} from "./signature-state-reading.ts";

/** Signet layout convention: the request index is ledger field 0. */
export const SIGNET_REQUESTS_INDEX_FIELD = 0;

/** Signet layout convention: the request counter (`SignetNonce`) is ledger field 1. */
export const SIGNET_NONCE_FIELD = 1;

/**
 * Aligned-value entry count of a request record EXCLUDING the capacity-scaled
 * vectors: requestNonce (1) + txParamType (1, enums are one atom whatever
 * their byte width) + the EVMType2TxParams fixed fields (to..value = 7,
 * accessListEntryCount = 1) + the calldata Maybe's is_some (1) and selector
 * (1) + the routing fields caip2Id..respondSerializationSchema (8). A stored
 * request cell therefore holds
 *   `REQUEST_FIXED_VALUE_ATOMS + 2·maxCalldataWords
 *      + maxAccessListEntries·(2 + maxStorageKeysPerEntry)`
 * entries (each ABIWord is kind + value = 2 atoms; each access-list entry is
 * address + storageKeyCount + its keys).
 */
export const REQUEST_FIXED_VALUE_ATOMS = 20;

/**
 * Recover a record's capacity instantiation (maxCalldataWords,
 * maxAccessListEntries, maxStorageKeysPerEntry) from its aligned-value atom
 * count and decode it. Unlike the old single-vector layout, one atom count no
 * longer determines the capacities uniquely, so candidates are enumerated —
 * access-list-free first (today's only producer, the vault, is <2, 0, 0>) —
 * and validated by the decode itself: the descriptors' Bytes length checks
 * and the enum range check reject wrong splits, and a decode that leaves
 * atoms unconsumed is rejected here.
 *
 * @param atoms - The record cell's aligned value (a fresh copy per attempt).
 * @returns The decoded record.
 * @throws Error if no capacity split decodes the value cleanly.
 */
function decodeSignBidirectionalEvent(
  atoms: AlignedValue,
): SignBidirectionalEvent {
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
  ): SignBidirectionalEvent | undefined => {
    const cursor = [...atoms] as AlignedValue;
    try {
      const record = signBidirectionalEventDescriptor(
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
  // No access list: variable atoms are calldata words alone.
  if (variable % 2 === 0) {
    const record = attempt(variable / 2, 0, 0);
    if (record !== undefined) return record;
  }
  // With an access list: E entries of (2 + K) atoms, the rest words.
  for (let entries = 1; entries * 2 <= variable; entries++) {
    for (let keys = 0; entries * (2 + keys) <= variable; keys++) {
      const rest = variable - entries * (2 + keys);
      if (rest % 2 !== 0) continue;
      const record = attempt(rest / 2, entries, keys);
      if (record !== undefined) return record;
    }
  }
  throw new Error(
    `request record with ${atoms.length} value entries matches no ` +
      `(calldata words, access-list entries, storage keys) capacity split`,
  );
}

/**
 * The decoded signet ledger fields of a conforming contract — the complete
 * view the MPC needs: the request index (field 0) and the request counter
 * (field 1, Compact `SignetNonce`), whose value doubles as a cheap
 * change-detection signal (unchanged nonce ⇒ no new requests).
 */
export interface SignetRequestsLedger {
  /** The request counter (ledger field {@link SIGNET_NONCE_FIELD}). */
  nonce: bigint;
  /**
   * The request index (ledger field {@link SIGNET_REQUESTS_INDEX_FIELD}),
   * keyed by hex request id.
   */
  requestsIndex: SignBidirectionalEventIndex;
}

/**
 * MPC-style read: parse the signet ledger fields out of raw contract state
 * by field position alone — no compiled contract, no generated `ledger()`,
 * only the signet layout convention and the canonical descriptors from
 * signet-requests.ts.
 *
 * @param raw - Raw contract state, e.g. `queryContractState(address).data`
 *   from the indexer or `ctx.currentQueryContext.state` from the simulator.
 * @returns The decoded {@link SignetRequestsLedger}.
 * @throws Error if a field is missing, has the wrong state-value shape, or a
 *   record matches no capacity split.
 */
export function readSignetRequestsLedgerFromState(raw: RawContractState): SignetRequestsLedger {
  const map = signetFieldNode(raw, SIGNET_REQUESTS_INDEX_FIELD).asMap();
  if (map === undefined) {
    throw new Error(`Ledger field ${SIGNET_REQUESTS_INDEX_FIELD} is not a Map`);
  }
  const requestsIndex: SignBidirectionalEventIndex = new Map();
  for (const key of map.keys()) {
    // fromValue consumes its input, so hand each descriptor a copy.
    const requestId = requestIdType.fromValue([...key.value]);
    const cell = map.get(key)?.asCell();
    if (cell === undefined) continue;
    requestsIndex.set(
      requestIdHex(requestId),
      decodeSignBidirectionalEvent(cell.value),
    );
  }

  const nonceCell = signetFieldNode(raw, SIGNET_NONCE_FIELD).asCell();
  if (nonceCell === undefined) {
    throw new Error(`Ledger field ${SIGNET_NONCE_FIELD} is not a Cell`);
  }
  const nonce = u64.fromValue([...nonceCell.value]);

  return { nonce, requestsIndex };
}
