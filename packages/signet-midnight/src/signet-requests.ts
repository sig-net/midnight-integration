// TypeScript twins of the CHAIN-AGNOSTIC request-side structs in the Compact
// library `Signet.compact` (same directory): the request record, its enums,
// request ids, and the runtime-descriptor toolkit shared by every tx-params
// decomposition. Everything specific to the EVM Type-2 decomposition (the
// only decomposition so far) lives in `signet-evtype2tx-requests.ts`.
//
// The shapes MUST stay in lockstep with the Compact structs: the
// compiler inlines struct types anonymously into each contract's generated
// managed/contract/index.d.ts, and these named types match them structurally,
// so ledger reads assign to them without casts.
//
// The lockstep is enforced by each consuming contract's simulator tests: the
// "signet-caller ledger shape" test in packages/caller-contract/tests/
// contract.test.ts assigns the generated `ledger().signBidirectionalEventMap`
// to the named SignBidirectionalEventLedgerMap type — the assignment itself is
// the assertion, so any structural drift between the generated managed types
// and these twins fails that package's `yarn build` / `yarn test`.
//
// Read more: https://docs.sig.network/ (signet protocol) and the module
// header in Signet.compact (key derivation, event flow).

import {
  CompactTypeBoolean,
  CompactTypeBytes,
  CompactTypeEnum,
  CompactTypeUnsignedInteger,
  type CompactType,
} from "@midnight-ntwrk/compact-runtime";

import type { EVMType2TxParams } from "./signet-evtype2tx-requests.ts";

/**
 * 32-byte signet request id (Compact: `new type RequestId = Bytes<32>`).
 * Chain-agnostic: downstream consumers treat it as an opaque key. Ids are
 * minted by `calculateRequestId` in Signet.compact — the persistent hash of
 * the full {@link SignBidirectionalEvent} record (which includes the sender
 * contract address, scoping ids per contract).
 */
export type RequestId = Uint8Array;

/**
 * A Midnight contract address as the generated code represents it in struct
 * fields (Compact `ContractAddress`): a single-field wrapper around the raw
 * 32 address bytes.
 */
export interface ContractAddress {
  bytes: Uint8Array;
}

/**
 * Which transaction-param decomposition a request carries (Compact:
 * `enum TxParamType`), as the generated code represents enums: a `number`
 * holding the 0-based variant index. Exported as a `const` object (not a TS
 * `enum`) so the values stay structurally `number`.
 */
export const TxParamType = {
  /** `EVMType2TxParams` (signet-evtype2tx-requests.ts): an EIP-1559 EVM transaction. */
  evmType2: 0,
  /**
   * Never emitted — mirrors the Compact-side padding variant that keeps the
   * enum at >= 2 variants (a 1-variant enum is a zero-byte value the proof
   * server cannot parse inside persistentHash preimages).
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
  /** Never emitted — the >= 2 variants padding (see {@link TxParamType}). */
  reserved: 1,
} as const;

/**
 * The MPC destination field (Compact: `enum MPCDestination`), 0-based
 * variant index. Reserved for future use.
 */
export const MPCDestination = {
  /** The only currently-valid value. */
  unused: 0,
  /** Never emitted — the >= 2 variants padding (see {@link TxParamType}). */
  reserved: 1,
} as const;

/**
 * Compact's standard-library `Maybe<T>` as the compiler generates it: a
 * plain struct. Even when `is_some` is false, `value` carries a full
 * default-valued `T` (so vector capacities remain inferable).
 */
export interface Maybe<T> {
  is_some: boolean;
  value: T;
}

/**
 * Canonical signet request record (Compact:
 * `SignBidirectionalEvent<TxParams, #LenOutputDeserialization,
 * #LenRespondSerialization>`), stored per {@link RequestId} in a requesting
 * contract's `SignBidirectionalEventMap` (at whichever ledger field the
 * contract declares it — its notifications name the position). Generic over
 * the tx-params decomposition, exactly like the Compact struct; the default
 * instantiation is {@link EVMType2TxParams} — the only decomposition so far;
 * new tx kinds supply their own type argument alongside their Compact struct.
 * The schema fields carry their contract-declared byte widths in their array
 * lengths.
 */
export interface SignBidirectionalEvent<TxParams = EVMType2TxParams> {
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
  /** Extra MPC parameters, reserved; 64 bytes. */
  params: Uint8Array;
  /** A {@link TxParamType} value tagging the txParams decomposition. */
  txParamType: number;
  /** The transaction decomposition. */
  txParams: TxParams;
  /** Target chain in CAIP-2 form (https://chainagnostic.org/CAIPs/caip-2), zero-padded; 32 bytes. */
  caip2Id: Uint8Array;
  /** MPC output_deserialization_schema (destination chain -> MPC); contract-declared width. */
  outputDeserializationSchema: Uint8Array;
  /** MPC respond_serialization_schema (MPC -> Midnight); contract-declared width. */
  respondSerializationSchema: Uint8Array;
}

// ---- Runtime descriptor toolkit (TS twin of the compiled struct codecs) ----
//
// DEVIATION from the "pure circuits are compiled, never re-written in TS"
// rule (see circuits.compact): the request-id circuit is generic over the
// tx-params type and schema lengths, the Compact compiler cannot export
// type-parameterized circuits from the top level, and a compiled copy would
// have to be monomorphized at ONE capacity instantiation — a client
// contract's choice that never belongs in this client-agnostic package. So
// the record descriptor (and the per-decomposition `calculateRequestId`
// built on it, see signet-evtype2tx-requests.ts) alone gets a TS twin here.
//
// It is NOT a hand-port of the hash algorithm: ids come from the very
// `persistentHash` runtime builtin that compiled circuits call, over runtime
// type descriptors mirroring the ones the compiler generates (compare
// `_calculateRequestId_0` in any consuming contract's
// managed/contract/index.js). What must stay in lockstep with Signet.compact
// is exactly what this file already keeps in lockstep — the struct shapes,
// field by field, in declaration order. Enforced by caller-contract's
// "submitSignatureRequest round-trip" test, which asserts the id computed
// here equals the ledger map key minted by the REAL compiled contract.

// Runtime descriptors of the Compact base types the generic record fields
// use. CompactTypeUnsignedInteger takes (maxValue, byte length) — same
// literals the compiler emits for Uint<8/64>. CompactTypeEnum takes
// (variantCount - 1, byte length); NOTE a 1-variant enum would compile to
// `CompactTypeEnum(0, 0)` — zero bytes, which the proof server cannot parse
// inside persistentHash preimages. Every enum therefore carries a padding
// `reserved` variant so it stays at (1, 1).
const BYTES_32 = new CompactTypeBytes(32);
const BYTES_64 = new CompactTypeBytes(64);
const UINT_8 = new CompactTypeUnsignedInteger(2n ** 8n - 1n, 1);
const UINT_64 = new CompactTypeUnsignedInteger(2n ** 64n - 1n, 8);
const TX_PARAM_TYPE = new CompactTypeEnum(1, 1);
const MPC_SIGNATURE_ALGORITHM = new CompactTypeEnum(1, 1);
const MPC_DESTINATION = new CompactTypeEnum(1, 1);

/**
 * Descriptor of a Compact `ContractAddress` struct field, exactly as the
 * compiler generates it: a single-field `{ bytes: Bytes<32> }` wrapper.
 */
const CONTRACT_ADDRESS: CompactType<ContractAddress> = {
  alignment: () => BYTES_32.alignment(),
  fromValue: (value) => ({ bytes: BYTES_32.fromValue(value) }),
  toValue: (value) => BYTES_32.toValue(value.bytes),
};

/**
 * Build the runtime descriptor of a Compact struct from its per-field
 * descriptors — the generic form of the struct descriptor classes the
 * compiler generates (field-by-field concatenation of alignments and values).
 *
 * Field ORDER must match the Compact struct declaration order; object
 * literals preserve insertion order for string keys, so pass fields in
 * declaration order.
 *
 * @param fields - One runtime descriptor per struct field, in declaration order.
 * @returns The composed struct descriptor.
 */
export function compactStructDescriptor<T extends object>(fields: {
  readonly [K in keyof T]-?: CompactType<T[K]>;
}): CompactType<T> {
  const entries = Object.entries(fields) as unknown as ReadonlyArray<
    [keyof T & string, CompactType<T[keyof T & string]>]
  >;
  return {
    alignment: () =>
      entries.flatMap(([, type]) => type.alignment()),
    toValue: (value) =>
      entries.flatMap(([key, type]) => type.toValue(value[key])),
    fromValue: (value) => {
      const result = {} as Record<keyof T & string, unknown>;
      for (const [key, type] of entries) {
        result[key] = type.fromValue(value);
      }
      return result as T;
    },
  };
}

/**
 * Descriptor of Compact's standard-library `Maybe<T>` — the compiler
 * generates it as the struct `{ is_some: Boolean, value: T }`.
 *
 * @param inner - Descriptor of the wrapped type.
 * @returns The Maybe struct descriptor.
 */
export function compactMaybeDescriptor<T>(inner: CompactType<T>): CompactType<Maybe<T>> {
  return compactStructDescriptor<Maybe<T>>({
    is_some: CompactTypeBoolean,
    value: inner,
  });
}

/**
 * Descriptor of {@link SignBidirectionalEvent} over ANY tx-params
 * decomposition — the TS analogue of Compact's generic
 * `SignBidirectionalEvent<TxParams, #LenOutputDeserialization,
 * #LenRespondSerialization>`. Each decomposition wraps this with its own
 * capacity-parameterized convenience (see `signBidirectionalEventDescriptor`
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
export interface SignBidirectionalEventLedgerMap
  extends Iterable<[RequestId, SignBidirectionalEvent]> {
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
   * @returns The stored request record; throws when absent — guard with
   *   {@link member} first.
   */
  lookup(requestId: RequestId): SignBidirectionalEvent;
}

declare const requestIdHexBrand: unique symbol;

/**
 * 64-char lowercase hex rendering of a {@link RequestId} — THE
 * representation of a request id everywhere in TypeScript. Raw
 * {@link RequestId} bytes appear only at the Compact boundary (state
 * readers, compiled-circuit calls); the moment an id crosses that boundary it
 * becomes this type. Branded (the TS analogue of Compact's `new type`) so an
 * arbitrary string cannot pose as a request id: mint one with
 * {@link requestIdHex} (from ledger bytes) or {@link parseRequestIdHex}
 * (from user input), and go back to bytes with {@link requestIdBytes}.
 */
export type RequestIdHex = string & {
  readonly [requestIdHexBrand]: true;
};

/** Plain-JS index parsed out of the ledger, keyed by hex request id. */
export type SignBidirectionalEventIndex = Map<
  RequestIdHex,
  SignBidirectionalEvent
>;

/**
 * Render bytes as a lowercase hex string, no `0x` prefix.
 *
 * @param bytes - The bytes to render.
 * @returns Lowercase hex, two chars per byte.
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Strip an optional `0x`/`0X` prefix from a hex string.
 *
 * @param hex - A hex string, with or without a `0x` prefix.
 * @returns The bare hex digits.
 */
export function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/**
 * Decode a hex string into bytes — the inverse of {@link bytesToHex}.
 *
 * @param hex - Hex digits, with or without a `0x` prefix.
 * @returns The decoded bytes.
 */
export function hexToBytes(hex: string): Uint8Array {
  const digits = stripHexPrefix(hex);
  const out = new Uint8Array(digits.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(digits.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

/**
 * Render a request id in its canonical TS form (see
 * {@link RequestIdHex}) — also usable as a JS `Map` key, which raw
 * `Uint8Array` ids are not (they compare by reference).
 *
 * @param requestId - 32-byte request id.
 * @returns The branded 64-char lowercase hex string, no `0x` prefix.
 */
export function requestIdHex(requestId: RequestId): RequestIdHex {
  return bytesToHex(requestId) as RequestIdHex;
}

/**
 * Validate and normalize an untrusted string (CLI argument, config value)
 * into a {@link RequestIdHex}: an optional `0x` prefix is stripped and
 * the digits lowercased before validation.
 *
 * @param value - The candidate request id string.
 * @returns The branded, normalized request id hex.
 * @throws Error if the value is not 64 hex chars after normalization.
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
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number.parseInt(id.slice(2 * i, 2 * i + 2), 16);
  }
  return bytes;
}

/**
 * Byte width of the path field (Compact `Bytes<32>`): 32 opaque bytes of the
 * client contract's choosing. Keys the MPC signs with are derived from
 * (contract address, path), so a contract can only ever reach keys scoped to
 * itself.
 */
export const PATH_BYTES = 32;

/**
 * Parse the on-ledger request map into a plain-JS index keyed by hex
 * request id.
 *
 * @param ledgerIndex - Iterable of `[requestId, request]` entries — e.g. a
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
