// TypeScript twins of the CHAIN-AGNOSTIC request-side structs in the Compact
// library `Signet.compact` (same directory): the request record, its enums,
// request ids, and the runtime-descriptor toolkit shared by every tx-params
// decomposition. Everything specific to the EVM Type-2 decomposition lives
// in `signet-evtype2tx-requests.ts`.
//
// The shapes MUST stay structurally in lockstep with the Compact structs,
// field by field in declaration order. Enforced by each consuming contract's
// simulator tests (the "ledger shape" test in
// packages/test-caller-contract/tests/contract.test.ts).

import {
  type CompactType,
  CompactTypeBytes,
  CompactTypeEnum,
} from "@midnight-ntwrk/compact-runtime";

import { bytesToHex, hexToBytes } from "./byte-codecs.ts";
import {
  BYTES_32,
  BYTES_64,
  compactStructDescriptor,
  CONTRACT_ADDRESS,
  type ContractAddress,
  UINT_8,
  UINT_64,
} from "./compact-descriptors.ts";
import type { EvmType2TxParams } from "./signet-evtype2tx-requests.ts";

// Public re-export: these types appear throughout the request record's shape.
export type { ContractAddress, Maybe } from "./compact-descriptors.ts";

/**
 * 32-byte signet request id (Compact: `new type RequestId = Bytes<32>`).
 * Chain-agnostic opaque key, minted by `calculateRequestId`.
 */
export type RequestId = Uint8Array;

/**
 * Descriptor of a request id ledger key (Compact `RequestId`, a nominal
 * `Bytes<32>`): encodes a {@link RequestId} to the stored aligned form and
 * back.
 */
export const requestIdType: CompactType<RequestId> = BYTES_32;

/**
 * Which transaction-param decomposition a request carries (Compact:
 * `enum TxParamType`), as the generated code represents enums: a `number`
 * holding the 0-based variant index. Exported as a `const` object so the
 * values stay structurally `number`.
 */
export const TxParamType = {
  /** `EvmType2TxParams` (signet-evtype2tx-requests.ts): an EIP-1559 EVM transaction. */
  evmType2: 0,
  /**
   * Never emitted: the Compact-side padding variant that keeps the enum at
   * >= 2 variants (a 1-variant enum is a zero-byte value the proof server
   * cannot parse inside persistentHash preimages).
   */
  reserved: 1,
} as const;

/**
 * Which signature algorithm the MPC uses (Compact:
 * `enum MPCSignatureAlgorithm`), 0-based variant index.
 */
export const MPCSignatureAlgorithm = {
  /** ECDSA over secp256k1. */
  ecdsa: 0,
  /** Never emitted: the >= 2 variants padding (see {@link TxParamType}). */
  reserved: 1,
} as const;

/**
 * The MPC destination field (Compact: `enum MPCDestination`), 0-based
 * variant index. Reserved for future use.
 */
export const MPCDestination = {
  /** The only currently-valid value. */
  unused: 0,
  /** Never emitted: the >= 2 variants padding (see {@link TxParamType}). */
  reserved: 1,
} as const;

/**
 * Canonical signet request record (Compact:
 * `SignBidirectionalEvent<TxParams, #LenOutputDeserialization,
 * #LenRespondSerialization>`), stored per {@link RequestId} in a requesting
 * contract's `SignBidirectionalEventMap`. Generic over the tx-params
 * decomposition, {@link EvmType2TxParams} by default. The schema fields
 * carry their contract-declared byte widths in their array lengths.
 */
export interface SignBidirectionalEvent<TxParams = EvmType2TxParams> {
  /** Address of the client contract that stores this event (`kernel.self()`). */
  sender: ContractAddress;
  /** Contract-local nonce captured when the request was created. */
  requestNonce: bigint;
  /** MPC root-key version to derive from (>= 1). */
  keyVersion: bigint;
  /** Key-derivation path: 32 opaque bytes of the client contract's choosing. */
  path: Uint8Array;
  /** An {@link MPCSignatureAlgorithm} value. */
  algo: number;
  /** An {@link MPCDestination} value. */
  dest: number;
  /** Extra MPC parameters: 64 opaque bytes, reserved, zero-filled. */
  params: Uint8Array;
  /** A {@link TxParamType} value tagging the txParams decomposition. */
  txParamType: number;
  /** The transaction decomposition. */
  txParams: TxParams;
  /** Target chain in CAIP-2 form (https://chainagnostic.org/CAIPs/caip-2), zero-padded, 32 bytes. */
  caip2Id: Uint8Array;
  /** MPC output_deserialization_schema (destination chain -> MPC), contract-declared width. */
  outputDeserializationSchema: Uint8Array;
  /** MPC respond_serialization_schema (MPC -> Midnight), contract-declared width. */
  respondSerializationSchema: Uint8Array;
}

// ---- Runtime descriptor toolkit (TS twin of the compiled struct codecs) ----
//
// DEVIATION from the "pure circuits are compiled, never re-written in TS"
// rule (see circuits.compact): the request-id circuit is generic over the
// tx-params type and schema lengths, and the Compact compiler cannot export
// type-parameterised circuits from the top level, so the record descriptor
// (and `calculateRequestId` built on it, see signet-request-id.ts) gets a TS
// twin here. Ids come from the same
// `keccak256` runtime builtin compiled circuits call. Lockstep with
// Signet.compact is enforced by test-caller-contract's
// "submitSignatureRequest round-trip" test, which asserts the id computed
// here equals the ledger map key minted by the compiled contract.

// Runtime descriptors of the signet enums, at the literals the compiler
// emits. NOTE: a 1-variant enum would compile to `CompactTypeEnum(0, 0)`,
// zero bytes, which the proof server cannot parse inside persistentHash
// preimages. Every enum therefore carries a padding `reserved` variant so it
// stays at (1, 1). The Compact-generic base descriptors live in
// compact-descriptors.ts.
const TX_PARAM_TYPE = new CompactTypeEnum(1, 1);
const MPC_SIGNATURE_ALGORITHM = new CompactTypeEnum(1, 1);
const MPC_DESTINATION = new CompactTypeEnum(1, 1);

/**
 
 * Descriptor of {@link SignBidirectionalEvent} over ANY tx-params
 * decomposition: the TS analogue of Compact's generic
 * `SignBidirectionalEvent`. Each decomposition wraps this with its own
 * capacity-parameterised convenience (see `signBidirectionalEventDescriptor`
 * in signet-evtype2tx-requests.ts for the EVM Type-2 one).
 *
 * @param txParams - Descriptor of the tx-params decomposition, already at
 *   its capacity instantiation.
 * @param lenOutputDeserialization - Declared byte width of
 *   `outputDeserializationSchema` (Compact `#LenOutputDeserialization`).
 * @param lenRespondSerialization - Declared byte width of
 *   `respondSerializationSchema` (Compact `#LenRespondSerialization`).
 * @returns The event record descriptor.
 */
export function signBidirectionalEventDescriptorWith<TxParams>(
  txParams: CompactType<TxParams>,
  lenOutputDeserialization: number,
  lenRespondSerialization: number,
): CompactType<SignBidirectionalEvent<TxParams>> {
  return compactStructDescriptor<SignBidirectionalEvent<TxParams>>({
    sender: CONTRACT_ADDRESS,
    requestNonce: UINT_64,
    keyVersion: UINT_8,
    path: BYTES_32,
    algo: MPC_SIGNATURE_ALGORITHM,
    dest: MPC_DESTINATION,
    params: BYTES_64,
    txParamType: TX_PARAM_TYPE,
    txParams,
    caip2Id: BYTES_32,
    outputDeserializationSchema: new CompactTypeBytes(lenOutputDeserialization),
    respondSerializationSchema: new CompactTypeBytes(lenRespondSerialization),
  });
}

/**
 * The generated ledger shape of `Map<RequestId, SignBidirectionalEvent>`:
 * what a contract's `ledger(state).signetRequestsIndex` provides. Structural,
 * so any contract exposing the index satisfies it.
 */
export interface SignBidirectionalEventLedgerMap extends Iterable<
  [RequestId, SignBidirectionalEvent]
> {
  /** @returns `true` when the index holds no requests. */
  isEmpty(): boolean;
  /** @returns Number of requests in the index. */
  size(): bigint;
  /**
   * @param requestId - 32-byte request id to probe.
   * @returns `true` when the index holds an entry for `requestId`.
   */
  member(requestId: RequestId): boolean;
  /**
   * @param requestId - 32-byte request id to fetch.
   * @returns The stored request record. Throws when absent: guard with
   *   {@link member} first.
   */
  lookup(requestId: RequestId): SignBidirectionalEvent;
}

declare const requestIdHexBrand: unique symbol;

/**
 * 64-char lowercase hex rendering of a {@link RequestId}: THE
 * representation of a request id everywhere in TypeScript, with raw
 * {@link RequestId} bytes appearing only at the Compact boundary. Branded
 * so an arbitrary string cannot pose as a request id: mint one with
 * {@link requestIdHex} (from ledger bytes) or {@link parseRequestIdHex}
 * (from user input), and go back to bytes with {@link requestIdBytes}.
 */
export type RequestIdHex = string & {
  readonly [requestIdHexBrand]: true;
};

/** Plain-JS index parsed out of the ledger, keyed by hex request id. */
export type SignBidirectionalEventIndex = Map<RequestIdHex, SignBidirectionalEvent>;

/**
 * Render a request id in its canonical TS form (see {@link RequestIdHex}).
 *
 * @param requestId - 32-byte request id.
 * @returns The branded 64-char lowercase hex string, no `0x` prefix.
 */
export function requestIdHex(requestId: RequestId): RequestIdHex {
  return bytesToHex(requestId) as RequestIdHex;
}

/**
 * Validate and normalise an untrusted string (CLI argument, config value)
 * into a {@link RequestIdHex}: strips an optional `0x` prefix and
 * lowercases.
 *
 * @param value - The candidate request id string.
 * @returns The branded, normalised request id hex.
 * @throws {Error} If the value is not 64 hex chars after normalisation.
 */
export function parseRequestIdHex(value: string): RequestIdHex {
  const hex = value.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`not a 32-byte request id in hex: "${value}"`);
  }
  return hex as RequestIdHex;
}

/**
 * Decode a request id back to its 32 raw bytes for the Compact boundary
 * (compiled-circuit calls, ledger lookups).
 *
 * @param id - The request id in canonical hex form.
 * @returns The 32-byte request id.
 */
export function requestIdBytes(id: RequestIdHex): RequestId {
  return hexToBytes(id);
}

/**
 * Byte width of the path field (Compact `Bytes<32>`): 32 opaque bytes of the
 * client contract's choosing.
 */
export const PATH_BYTES = 32;

/**
 * Parse the on-ledger request map into a plain-JS index keyed by hex
 * request id.
 *
 * @param ledgerIndex - Iterable of `[requestId, request]` entries, e.g. a
 *   contract's `ledger(state).signBidirectionalEventMap` (any
 *   {@link SignBidirectionalEventLedgerMap}).
 * @returns A new `Map` from {@link requestIdHex} key to request record.
 */
export function toSignBidirectionalEventIndex(
  ledgerIndex: Iterable<[RequestId, SignBidirectionalEvent]>,
): SignBidirectionalEventIndex {
  const index: SignBidirectionalEventIndex = new Map();
  for (const [requestId, request] of ledgerIndex) {
    index.set(requestIdHex(requestId), request);
  }
  return index;
}
