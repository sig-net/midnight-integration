// Common signet raw-state reading, shared by the request and response readers
// (signature-requests-state-reader.ts, signet-contract-state-reader.ts).
// This is the MPC-/client-style path: decode a contract's ledger fields out of
// its raw state WITHOUT the compiled contract, walking the state tree by field
// position alone. Here live the generic tree walk (RawContractState,
// signetFieldNode) and the base type descriptors both readers share; each
// reader adds only the descriptors for its own layout.

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
 * Descriptor for a request id ledger key (Compact `RequestId`, a
 * nominal `Bytes<32>`). Use it to encode a {@link RequestId} into the
 * aligned form the state tree stores, or decode one back.
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
 * Resolve a flat ledger field index to its node in the raw state tree.
 *
 * The runtime stores ledger fields as a root array and chunks them one level
 * deep once the field count grows, so chunked roots are flattened before
 * indexing. Chunk detection assumes signet field 0 is a `Map`, never a
 * `List` (whose node is also array-typed) — guaranteed by the signet layout
 * convention.
 *
 * @param raw - Raw contract state from the indexer or simulator.
 * @param flatIndex - Zero-based ledger field position in declaration order.
 * @returns The `StateValue` node holding that field.
 * @throws Error if `flatIndex` is beyond the contract's field count.
 */
export function signetFieldNode(
  raw: RawContractState,
  flatIndex: number,
): StateValue {
  const root = unwrap(raw);
  if (root.type() !== "array") {
    if (flatIndex === 0) return root;
    throw new Error(`Field index ${flatIndex} out of range: root is a leaf`);
  }
  const nodes = root.asArray() ?? [];
  const fields =
    nodes[0]?.type() === "array"
      ? nodes.flatMap((chunk) => chunk.asArray() ?? [])
      : nodes;
  const node = fields[flatIndex];
  if (node === undefined) {
    throw new Error(`Field index ${flatIndex} out of range`);
  }
  return node;
}
