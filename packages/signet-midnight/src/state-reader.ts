// MPC-style raw state reader: decode the signet request index out of a
// contract's raw ledger state WITHOUT the compiled contract. This is how the
// MPC monitor consumes signet contracts — it has only a contract address,
// queries raw state from the indexer (queryContractState(address).data), and
// decodes by the signet convention: the request index is the FIRST ledger
// field. The compiled contract's generated ledger() does exactly this walk
// internally; here we hand-compose the same compact-runtime type descriptors.

import {
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  CompactTypeVector,
  type CompactType,
  type StateValue,
} from "@midnight-ntwrk/compact-runtime";

import {
  requestIdHex,
  type EVMCalldata,
  type EVMTransactionParams,
  type SignetEVMSignatureRequest,
  type SignetEVMSignatureRequestIndex,
  type SignetMPCRoutingParams,
  type SignetRequestId,
} from "./signet-requests.ts";

/** Signet layout convention: the request index is ledger field 0. */
export const SIGNET_REQUESTS_INDEX_FIELD = 0;

// ---- Type descriptors (must mirror SignetRequests.compact field-for-field) ----
// Field order and widths MUST match the Compact structs: fromValue consumes
// the aligned value sequentially, so a reorder or width change here is silent
// data corruption, not an error.

const u32 = new CompactTypeUnsignedInteger(4294967295n, 4);
const u64 = new CompactTypeUnsignedInteger(18446744073709551615n, 8);
const u128 = new CompactTypeUnsignedInteger(
  340282366920938463463374607431768211455n,
  16,
);
const bytes20 = new CompactTypeBytes(20);
const bytes32 = new CompactTypeBytes(32);
const bytes64 = new CompactTypeBytes(64);
const bytes256 = new CompactTypeBytes(256);
const bytes512 = new CompactTypeBytes(512);
const argsVector = new CompactTypeVector(4, bytes32);

/**
 * Descriptor for a request id ledger key (Compact `SignetRequestId`, a
 * nominal `Bytes<32>`). Use it to encode a {@link SignetRequestId} into the
 * aligned form the state tree stores, or decode one back.
 */
export const requestIdType: CompactType<SignetRequestId> = bytes32;

/**
 * Descriptor for the decomposed EVM transaction (Compact
 * `EVMTransactionParams`).
 */
export const evmTransactionParamsType: CompactType<EVMTransactionParams> = {
  /** @returns Compound alignment of the struct's fields in declaration order. */
  alignment() {
    return bytes20
      .alignment()
      .concat(u64.alignment())
      .concat(u64.alignment())
      .concat(u64.alignment())
      .concat(u128.alignment())
      .concat(u128.alignment())
      .concat(u128.alignment());
  },
  /**
   * Decode the params from an aligned value, consuming it field by field.
   *
   * @param value - Mutable aligned value cursor; pass a copy.
   * @returns The decoded EVM transaction params.
   */
  fromValue(value) {
    return {
      to: bytes20.fromValue(value),
      chainId: u64.fromValue(value),
      nonce: u64.fromValue(value),
      gasLimit: u64.fromValue(value),
      maxFeePerGas: u128.fromValue(value),
      maxPriorityFeePerGas: u128.fromValue(value),
      value: u128.fromValue(value),
    };
  },
  /**
   * Encode the params into their aligned on-ledger representation.
   *
   * @param params - The EVM transaction params to encode.
   * @returns The aligned value, fields concatenated in declaration order.
   */
  toValue(params) {
    return bytes20
      .toValue(params.to)
      .concat(u64.toValue(params.chainId))
      .concat(u64.toValue(params.nonce))
      .concat(u64.toValue(params.gasLimit))
      .concat(u128.toValue(params.maxFeePerGas))
      .concat(u128.toValue(params.maxPriorityFeePerGas))
      .concat(u128.toValue(params.value));
  },
};

/** Descriptor for the ABI calldata block (Compact `EVMCalldata`). */
export const evmCalldataType: CompactType<EVMCalldata> = {
  /** @returns Compound alignment of the struct's fields in declaration order. */
  alignment() {
    return bytes256
      .alignment()
      .concat(u32.alignment())
      .concat(argsVector.alignment());
  },
  /**
   * Decode the calldata from an aligned value, consuming it field by field.
   *
   * @param value - Mutable aligned value cursor; pass a copy.
   * @returns The decoded calldata block.
   */
  fromValue(value) {
    return {
      funcSig: bytes256.fromValue(value),
      argCount: u32.fromValue(value),
      args: argsVector.fromValue(value),
    };
  },
  /**
   * Encode the calldata into its aligned on-ledger representation.
   *
   * @param calldata - The calldata block to encode.
   * @returns The aligned value, fields concatenated in declaration order.
   */
  toValue(calldata) {
    return bytes256
      .toValue(calldata.funcSig)
      .concat(u32.toValue(calldata.argCount))
      .concat(argsVector.toValue(calldata.args));
  },
};

/** Descriptor for the MPC routing block (Compact `SignetMPCRoutingParams`). */
export const signetMPCRoutingParamsType: CompactType<SignetMPCRoutingParams> = {
  /** @returns Compound alignment of the struct's fields in declaration order. */
  alignment() {
    return bytes64
      .alignment()
      .concat(u32.alignment())
      .concat(bytes256.alignment())
      .concat(bytes32.alignment())
      .concat(bytes64.alignment())
      .concat(bytes512.alignment())
      .concat(bytes256.alignment())
      .concat(bytes256.alignment());
  },
  /**
   * Decode the routing params from an aligned value, consuming it field by
   * field.
   *
   * @param value - Mutable aligned value cursor; pass a copy.
   * @returns The decoded routing params.
   */
  fromValue(value) {
    return {
      caip2Id: bytes64.fromValue(value),
      keyVersion: u32.fromValue(value),
      path: bytes256.fromValue(value),
      algo: bytes32.fromValue(value),
      dest: bytes64.fromValue(value),
      params: bytes512.fromValue(value),
      outputSchema: bytes256.fromValue(value),
      respondSchema: bytes256.fromValue(value),
    };
  },
  /**
   * Encode the routing params into their aligned on-ledger representation.
   *
   * @param routing - The routing params to encode.
   * @returns The aligned value, fields concatenated in declaration order.
   */
  toValue(routing) {
    return bytes64
      .toValue(routing.caip2Id)
      .concat(u32.toValue(routing.keyVersion))
      .concat(bytes256.toValue(routing.path))
      .concat(bytes32.toValue(routing.algo))
      .concat(bytes64.toValue(routing.dest))
      .concat(bytes512.toValue(routing.params))
      .concat(bytes256.toValue(routing.outputSchema))
      .concat(bytes256.toValue(routing.respondSchema));
  },
};

/**
 * Hand-composed descriptor for {@link SignetEVMSignatureRequest} — identical
 * to the struct class the Compact compiler emits into each consuming
 * contract's managed output. Nested structs encode as plain concatenation, so
 * this composes the three sub-descriptors around the leading nonce.
 */
export const signetEVMSignatureRequestType: CompactType<SignetEVMSignatureRequest> =
  {
    /** @returns Compound alignment of the struct's fields in declaration order. */
    alignment() {
      return u64
        .alignment()
        .concat(evmTransactionParamsType.alignment())
        .concat(evmCalldataType.alignment())
        .concat(signetMPCRoutingParamsType.alignment());
    },
    /**
     * Decode one request from an aligned value, consuming it field by field.
     *
     * @param value - Mutable aligned value cursor; each field decode consumes
     *   its slice, so callers must pass a copy (`[...cell.value]`).
     * @returns The decoded request record.
     */
    fromValue(value) {
      return {
        requestNonce: u64.fromValue(value),
        evmTransaction: evmTransactionParamsType.fromValue(value),
        calldata: evmCalldataType.fromValue(value),
        mpcRouting: signetMPCRoutingParamsType.fromValue(value),
      };
    },
    /**
     * Encode a request into its aligned on-ledger representation.
     *
     * @param request - The request record to encode.
     * @returns The aligned value, fields concatenated in declaration order.
     */
    toValue(request) {
      return u64
        .toValue(request.requestNonce)
        .concat(evmTransactionParamsType.toValue(request.evmTransaction))
        .concat(evmCalldataType.toValue(request.calldata))
        .concat(signetMPCRoutingParamsType.toValue(request.mpcRouting));
    },
  };

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

/**
 * MPC-style read: parse the signet request index out of raw contract state
 * by field position alone — no compiled contract, no generated `ledger()`,
 * only the signet layout convention and the canonical descriptors above.
 *
 * @param raw - Raw contract state, e.g. `queryContractState(address).data`
 *   from the indexer or `ctx.currentQueryContext.state` from the simulator.
 * @param fieldIndex - Ledger field position of the request index; defaults
 *   to {@link SIGNET_REQUESTS_INDEX_FIELD} per the signet convention.
 * @returns The decoded index, keyed by hex request id.
 * @throws Error if the field is missing or is not a `Map`.
 */
export function readSignetEVMSignatureRequestIndexFromState(
  raw: RawContractState,
  fieldIndex: number = SIGNET_REQUESTS_INDEX_FIELD,
): SignetEVMSignatureRequestIndex {
  const map = signetFieldNode(raw, fieldIndex).asMap();
  if (map === undefined) {
    throw new Error(`Ledger field ${fieldIndex} is not a Map`);
  }
  const index: SignetEVMSignatureRequestIndex = new Map();
  for (const key of map.keys()) {
    // fromValue consumes its input, so hand each descriptor a copy.
    const requestId = requestIdType.fromValue([...key.value]);
    const cell = map.get(key)?.asCell();
    if (cell === undefined) continue;
    index.set(
      requestIdHex(requestId),
      signetEVMSignatureRequestType.fromValue([...cell.value]),
    );
  }
  return index;
}
