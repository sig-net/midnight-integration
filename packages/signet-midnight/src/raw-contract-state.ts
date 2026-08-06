// Raw contract state and the walk over it: the state shape every signet
// reader accepts, and the resolved ledger-tree path walk that finds a
// contract's ledger fields in it.

import type { StateValue } from "@midnight-ntwrk/compact-runtime";

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



















