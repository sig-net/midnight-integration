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
 * The compact compiler's chunking arity: a StateValue array level holds at
 * most this many entries, so a contract with more ledger fields gets a
 * depth-uniform tree of chunks (see {@link signetFieldNode}).
 */
const CHUNK_ARITY = 15;

/**
 * Resolve a flat ledger field index to its node in the raw state tree: the
 * MPC-perspective primitive: given only a contract's raw state and a field
 * number (e.g. the `requestsIndexField` a notification names), return that
 * field's block of stored state, regardless of what field types sit before
 * or after it.
 *
 * Layout, as compactc emits it (probed on 4/15/16/20/226-field contracts;
 * the generated `ledger()` reader indexes with exactly these paths):
 * - Up to {@link CHUNK_ARITY} fields: the root array holds the fields
 *   directly, field n at `root[n]`.
 * - More fields: a depth-uniform tree of chunk arrays, filled REMAINDER
 *   FIRST: 16 fields become chunks of [1, 15], 20 become [5, 15], 226
 *   become [1, 15x15] one level deeper. Every chunk on the rightmost spine
 *   is therefore always FULL (exactly {@link CHUNK_ARITY} entries).
 *
 * Chunk detection walks that rightmost spine: each consecutive
 * arity-{@link CHUNK_ARITY} array is one chunk level to flatten. This never
 * misreads a field node as a chunk, because no ledger ADT stores an
 * arity-15 array at field level; in particular a `List` (array-typed, like
 * a chunk) is a fixed THREE-slot cons node. The one theoretical blind spot
 * is a future ADT whose field node is an arity-15 array sitting exactly at
 * the last declared field of a contract.
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
  let fields = root.asArray() ?? [];

  // Count chunk levels below the root along the rightmost spine: chunks on
  // it are always full, field nodes never have CHUNK_ARITY entries.
  let chunkLevels = 0;
  let spine = fields[fields.length - 1];
  while (
    spine !== undefined &&
    spine.type() === "array" &&
    (spine.asArray()?.length ?? 0) === CHUNK_ARITY
  ) {
    chunkLevels += 1;
    const children = spine.asArray() ?? [];
    spine = children[children.length - 1];
  }

  for (let level = 0; level < chunkLevels; level += 1) {
    fields = fields.flatMap((chunk) => chunk.asArray() ?? []);
  }

  const node = fields[flatIndex];
  if (node === undefined) {
    throw new Error(`Field index ${flatIndex} out of range`);
  }
  return node;
}
