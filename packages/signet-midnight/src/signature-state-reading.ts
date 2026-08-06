// Common signet raw-state reading for the request-side readers
// (signature-requests-state-reader.ts): decode a contract's ledger fields
// out of its raw state by resolved ledger-tree path. Here live the generic
// path walk and the base type descriptors the readers share.

import {
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  type CompactType,
  type StateValue,
} from "@midnight-ntwrk/compact-runtime";

import { type RequestId } from "./signet-requests.ts";

// ---- Shared base type descriptors ----
// fromValue consumes the aligned value sequentially, so any width change here
// is silent data corruption, not an error. These mirror the Compact base types
// used across both signet layouts.

/** Descriptor for a Compact `Uint<64>` (8-byte unsigned integer). */
export const u64 = new CompactTypeUnsignedInteger(18446744073709551615n, 8);

/** Descriptor for a Compact `Bytes<32>`. */
export const bytes32 = new CompactTypeBytes(32);

/**
 * Descriptor for a request id ledger key (Compact `RequestId`, a nominal
 * `Bytes<32>`): encodes a {@link RequestId} to the stored aligned form and
 * back.
 */
export const requestIdType: CompactType<RequestId> = bytes32;

// ---- Raw state walk ----

/**
 * What the indexer / simulator hands us: a bare `StateValue`, or anything
 * wrapping one under `.state` (e.g. `ChargedState`,
 * `queryContractState(address).data`).
 */
export type RawContractState = StateValue | { state: StateValue };

/**
 * Unwrap a {@link RawContractState} to the underlying `StateValue`.
 *
 * @param raw - Bare state value or a `.state`-carrying wrapper.
 * @returns The bare `StateValue`.
 */
const unwrap = (raw: RawContractState): StateValue =>
  "state" in raw ? raw.state : raw;

/**
 * Follow a resolved ledger-tree path to its node in raw state: the
 * MPC-perspective primitive, given only a contract's raw state and the path
 * a notification carries. The path is the value compactc records for a
 * field in the client's own `contract-info.json` (`"index"`): a
 * single-element path (`[4]`) for a flat contract's field, a longer one
 * (`[1, 14]`) once the compiler stores fields in a chunk tree.
 *
 * @param raw - Raw contract state from the indexer or simulator.
 * @param path - Resolved chunk-tree path in declaration order.
 * @returns The `StateValue` node at the end of the path.
 * @throws Error if `path` is empty, steps into a non-array, or an index is out
 *   of range.
 */
export function signetFieldNodeByPath(
  raw: RawContractState,
  path: readonly number[],
): StateValue {
  if (path.length === 0) {
    throw new Error("Ledger field path is empty");
  }
  let node = unwrap(raw);
  for (const [level, index] of path.entries()) {
    if (node.type() !== "array") {
      // A one-field contract stores its field as the bare (non-array) root,
      // addressable only as the whole state at a final [0]. The compiled
      // accessor reads it the same way.
      if (index === 0 && level === path.length - 1) return node;
      throw new Error(
        `Ledger field path ${JSON.stringify(path)} steps into a non-array at level ${level}`,
      );
    }
    const next = (node.asArray() ?? [])[index];
    if (next === undefined) {
      throw new Error(
        `Ledger field path ${JSON.stringify(path)} index ${index} out of range at level ${level}`,
      );
    }
    node = next;
  }
  return node;
}
