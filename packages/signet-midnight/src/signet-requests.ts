// TypeScript twins of the request-side structs in the Compact library
// `Signet.compact` (same directory). The shapes MUST stay in lockstep with the Compact structs: the
// compiler inlines struct types anonymously into each contract's generated
// managed/contract/index.d.ts, and these named types match them structurally,
// so ledger reads assign to them without casts.
//
// The lockstep is enforced by each consuming contract's simulator tests: the
// "erc20-vault ledger shape" test in packages/vault-contract/tests/
// contract.test.ts assigns the generated `ledger().signetRequestsIndex` to the
// named SignBidirectionalEventLedgerIndex type — the assignment itself is
// the assertion, so any structural drift between the generated managed types
// and these twins fails that package's `npm run build` / `npm run test`.
//
// Read more: https://docs.sig.network/ (signet protocol) and the module
// header in Signet.compact (layout convention, path binding).

import {
  CompactTypeBoolean,
  CompactTypeBytes,
  CompactTypeEnum,
  CompactTypeUnsignedInteger,
  CompactTypeVector,
  persistentHash,
  type CompactType,
} from "@midnight-ntwrk/compact-runtime";
import { getAddress, getBytes, Signature, Transaction } from "ethers";

import { asciiPadded } from "./constants.ts";
import { bigintToBytes32, bytesToBigint } from "./schnorr.ts";
import type { SignatureRespondedEvent } from "./signet-contract-state-reader.ts";

/**
 * 32-byte signet request id (Compact: `new type RequestId = Bytes<32>`).
 * Chain-agnostic: downstream consumers treat it as an opaque key. Ids are
 * minted by `calculateRequestId` in Signet.compact — the domain-separated
 * hash of the full {@link SignBidirectionalEvent} record.
 */
export type RequestId = Uint8Array;

/**
 * Which transaction-param decomposition a request carries (Compact:
 * `enum TxParamType`), as the generated code represents enums: a `number`
 * holding the 0-based variant index. Exported as a `const` object (not a TS
 * `enum`) so the values stay structurally `number`.
 */
export const TxParamType = {
  /** {@link EVMType2TxParams}: an EIP-1559 EVM transaction. */
  evmType2: 0,
} as const;

/**
 * How the MPC must handle one {@link ABIWord} when re-assembling calldata
 * (Compact: `enum ABIWordKind`). The numeric kinds (staticArg, dynArgHead,
 * dynArgLength) are little-endian field embeds re-encoded as big-endian ABI
 * words; dynArgData is copied verbatim; unused is dropped.
 */
export const ABIWordKind = {
  staticArg: 0,
  dynArgHead: 1,
  dynArgLength: 2,
  dynArgData: 3,
  unused: 4,
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

/** One tagged 32-byte ABI slot of the calldata body (Compact: `ABIWord`). */
export interface ABIWord {
  /** An {@link ABIWordKind} value. */
  kind: number;
  /** The 32-byte slot content; interpretation depends on `kind`. */
  value: Uint8Array;
}

/**
 * ABI calldata as 4-byte selector + tagged word slots (Compact:
 * `EVMCalldata<#maxWords>`). The words vector IS the calldata body:
 * `data = selector || processed words` — see {@link assembleCalldata}.
 * Head/tail layout (https://docs.soliditylang.org/en/latest/abi-spec.html)
 * is produced by the client; the MPC never computes or validates offsets.
 */
export interface EVMCalldata {
  /** The literal first 4 calldata bytes (big-endian, as broadcast). */
  selector: Uint8Array;
  /** Tagged ABI slots; capacity is the contract's `#maxWords` (vault: 2). */
  words: ABIWord[];
}

/**
 * One EIP-2930 access-list entry (Compact:
 * `EVMAccessListEntry<#maxStorageKeys>`).
 */
export interface EVMAccessListEntry {
  /** The pre-declared contract address, 20 display-order bytes. */
  address: Uint8Array;
  /** How many leading {@link storageKeys} are real. */
  storageKeyCount: bigint;
  /** Raw 32-byte storage keys, copied verbatim into the transaction. */
  storageKeys: Uint8Array[];
}

/**
 * The EVM transaction to be signed, decomposed into typed fields (Compact:
 * `EVMType2TxParams<#maxCalldataWords, #maxAccessListEntries,
 * #maxStorageKeysPerEntry>`; EIP-1559 — https://eips.ethereum.org/EIPS/eip-1559).
 * Compact `Bytes<N>` fields arrive as N-byte `Uint8Array`s, `Uint<N>` as
 * `bigint`. Vector capacities are each contract's compile-time throttle;
 * the runtime counts say how many leading slots are real.
 */
export interface EVMType2TxParams {
  /** Call target (e.g. the ERC20 contract), 20 bytes. */
  to: Uint8Array;
  /** EVM chain id (also expressed in {@link SignBidirectionalEvent.caip2Id}). */
  chainId: bigint;
  /** Account nonce of the MPC-derived sender address. */
  nonce: bigint;
  /** Gas ceiling for the call. */
  gasLimit: bigint;
  /** Max total fee per gas, wei. */
  maxFeePerGas: bigint;
  /** Max priority fee per gas, wei. */
  maxPriorityFeePerGas: bigint;
  /** ETH sent with the call, wei. */
  value: bigint;
  /** How many leading {@link accessList} entries are real. */
  accessListEntryCount: bigint;
  /** EIP-2930 access list slots (capacity = contract's throttle). */
  accessList: EVMAccessListEntry[];
  /** Call data; `is_some: false` means a plain ETH transfer (`0x` data). */
  calldata: Maybe<EVMCalldata>;
}

/**
 * Canonical signet request record (Compact:
 * `SignBidirectionalEvent<TxParams>`), stored per {@link RequestId} in a
 * requesting contract's index (ledger field 0). Mirrors the MPC's
 * SignBidirectionalEvent with the transaction decomposed. The TS twin fixes
 * the type parameter at {@link EVMType2TxParams} — the only decomposition
 * so far; new tx kinds add a union here alongside their Compact struct.
 */
export interface SignBidirectionalEvent {
  /** Contract-local nonce captured when the request was created. */
  requestNonce: bigint;
  /** A {@link TxParamType} value tagging the txParams decomposition. */
  txParamType: number;
  /** The transaction decomposition. */
  txParams: EVMType2TxParams;
  /** Target chain in CAIP-2 form (https://chainagnostic.org/CAIPs/caip-2), zero-padded; 32 bytes. */
  caip2Id: Uint8Array;
  /** MPC root-key version to derive from (>= 1; version 0 is the unsupported legacy format). */
  keyVersion: bigint;
  /** Key-derivation path: canonical lowercase hex of the caller's identity commitment, zero-padded; 256 bytes. */
  path: Uint8Array;
  /** Signature scheme, zero-padded ASCII, e.g. "ecdsa"; 32 bytes. */
  algo: Uint8Array;
  /** Response destination, zero-padded ASCII, e.g. "ethereum"; 32 bytes. */
  dest: Uint8Array;
  /** Scheme-specific extras, opaque; 64 bytes. */
  params: Uint8Array;
  /** MPC output_deserialization_schema (destination chain -> MPC); 128 bytes. */
  outputDeserializationSchema: Uint8Array;
  /** MPC respond_serialization_schema (MPC -> source chain); 128 bytes. */
  respondSerializationSchema: Uint8Array;
}

// ---- Request id (TS twin of the Compact circuit) ---------------------------
//
// DEVIATION from the "pure circuits are compiled, never re-written in TS"
// rule (see circuits.compact): `calculateRequestId` is generic over the
// tx-params type, the Compact compiler cannot export type-parameterized
// circuits from the top level, and a compiled copy would have to be
// monomorphized at ONE capacity instantiation — a client contract's choice
// that never belongs in this client-agnostic package. So the request-id
// circuit alone gets a TS twin here.
//
// It is NOT a hand-port of the hash algorithm: it calls the very
// `persistentHash` runtime builtin that compiled circuits call, over runtime
// type descriptors mirroring the ones the compiler generates (compare
// `_calculateRequestId_0` in any consuming contract's
// managed/contract/index.js). What must stay in lockstep with Signet.compact
// is exactly what this file already keeps in lockstep — the struct shapes,
// field by field, in declaration order. Enforced by vault-contract's
// "deposit round-trip" test, which asserts the id computed here equals the
// ledger map key minted by the REAL compiled contract.

// Runtime descriptors of the Compact base types the request record uses.
// CompactTypeUnsignedInteger takes (maxValue, byte length) — same literals
// the compiler emits for Uint<8/32/64/128>. CompactTypeEnum takes
// (variantCount - 1, byte length); NOTE the compiler gives a 1-variant enum
// byte length ZERO (TxParamType compiles to `CompactTypeEnum(0, 0)` — it
// contributes no bytes), growing to 1 as soon as a second variant lands.
const BYTES_4 = new CompactTypeBytes(4);
const BYTES_20 = new CompactTypeBytes(20);
const BYTES_32 = new CompactTypeBytes(32);
const BYTES_64 = new CompactTypeBytes(64);
const BYTES_128 = new CompactTypeBytes(128);
const BYTES_256 = new CompactTypeBytes(256);
const UINT_8 = new CompactTypeUnsignedInteger(2n ** 8n - 1n, 1);
const UINT_32 = new CompactTypeUnsignedInteger(2n ** 32n - 1n, 4);
const UINT_64 = new CompactTypeUnsignedInteger(2n ** 64n - 1n, 8);
const UINT_128 = new CompactTypeUnsignedInteger(2n ** 128n - 1n, 16);
const TX_PARAM_TYPE = new CompactTypeEnum(0, 0);
const ABI_WORD_KIND = new CompactTypeEnum(4, 1);

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
function compactStructDescriptor<T extends object>(fields: {
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
function compactMaybeDescriptor<T>(inner: CompactType<T>): CompactType<Maybe<T>> {
  return compactStructDescriptor<Maybe<T>>({
    is_some: CompactTypeBoolean,
    value: inner,
  });
}

/** Descriptor of {@link ABIWord} (Compact: `ABIWord`). */
const ABI_WORD_DESCRIPTOR = compactStructDescriptor<ABIWord>({
  kind: ABI_WORD_KIND,
  value: BYTES_32,
});

/**
 * Descriptor of {@link EVMCalldata} at one word capacity — the TS analogue
 * of instantiating Compact's `EVMCalldata<#maxWords>`.
 *
 * @param maxWords - The contract's calldata word capacity (the vault uses 2).
 * @returns The calldata descriptor.
 */
export function evmCalldataDescriptor(maxWords: number): CompactType<EVMCalldata> {
  return compactStructDescriptor<EVMCalldata>({
    selector: BYTES_4,
    words: new CompactTypeVector(maxWords, ABI_WORD_DESCRIPTOR),
  });
}

/**
 * Descriptor of {@link EVMAccessListEntry} at one storage-key capacity
 * (Compact: `EVMAccessListEntry<#maxStorageKeys>`).
 *
 * @param maxStorageKeys - Storage-key capacity per entry.
 * @returns The entry descriptor.
 */
export function evmAccessListEntryDescriptor(
  maxStorageKeys: number,
): CompactType<EVMAccessListEntry> {
  return compactStructDescriptor<EVMAccessListEntry>({
    address: BYTES_20,
    storageKeyCount: UINT_8,
    storageKeys: new CompactTypeVector(maxStorageKeys, BYTES_32),
  });
}

/**
 * Descriptor of {@link EVMType2TxParams} at one capacity instantiation —
 * the TS analogue of Compact's `EVMType2TxParams<#maxCalldataWords,
 * #maxAccessListEntries, #maxStorageKeysPerEntry>`.
 *
 * @param maxCalldataWords - Calldata word capacity.
 * @param maxAccessListEntries - Access-list entry capacity.
 * @param maxStorageKeysPerEntry - Storage-key capacity per entry.
 * @returns The tx-params descriptor.
 */
export function evmType2TxParamsDescriptor(
  maxCalldataWords: number,
  maxAccessListEntries: number,
  maxStorageKeysPerEntry: number,
): CompactType<EVMType2TxParams> {
  return compactStructDescriptor<EVMType2TxParams>({
    to: BYTES_20,
    chainId: UINT_64,
    nonce: UINT_64,
    gasLimit: UINT_64,
    maxFeePerGas: UINT_128,
    maxPriorityFeePerGas: UINT_128,
    value: UINT_128,
    accessListEntryCount: UINT_8,
    accessList: new CompactTypeVector(
      maxAccessListEntries,
      evmAccessListEntryDescriptor(maxStorageKeysPerEntry),
    ),
    calldata: compactMaybeDescriptor(evmCalldataDescriptor(maxCalldataWords)),
  });
}

/**
 * Descriptor of {@link SignBidirectionalEvent} at one capacity instantiation.
 *
 * @param maxCalldataWords - Calldata word capacity.
 * @param maxAccessListEntries - Access-list entry capacity.
 * @param maxStorageKeysPerEntry - Storage-key capacity per entry.
 * @returns The request record descriptor.
 */
export function signBidirectionalEventDescriptor(
  maxCalldataWords: number,
  maxAccessListEntries: number,
  maxStorageKeysPerEntry: number,
): CompactType<SignBidirectionalEvent> {
  return compactStructDescriptor<SignBidirectionalEvent>({
    requestNonce: UINT_64,
    txParamType: TX_PARAM_TYPE,
    txParams: evmType2TxParamsDescriptor(
      maxCalldataWords,
      maxAccessListEntries,
      maxStorageKeysPerEntry,
    ),
    caip2Id: BYTES_32,
    keyVersion: UINT_32,
    path: BYTES_256,
    algo: BYTES_32,
    dest: BYTES_32,
    params: BYTES_64,
    outputDeserializationSchema: BYTES_128,
    respondSerializationSchema: BYTES_128,
  });
}

/**
 * Domain tag partitioning the {@link RequestId} space
 * (Compact: `pad(32, "signet:midnight:request")`).
 */
const REQUEST_ID_DOMAIN_TAG = asciiPadded("signet:midnight:request", 32);

/**
 * Canonical id of a signet request: the domain-separated persistent hash of
 * the entire request record. TS twin of Signet.compact's `calculateRequestId`
 * circuit (see the deviation note atop this section), generic over the
 * capacity instantiation via the record's own array lengths — pass the
 * record exactly as the ledger stores it, unused slots included.
 *
 * @param request - The full request record (contract-shaped, all slots).
 * @returns The 32-byte request id — the record's ledger map key.
 */
export function calculateRequestId(request: SignBidirectionalEvent): RequestId {
  const { txParams } = request;
  const maxCalldataWords = txParams.calldata.value.words.length;
  const maxAccessListEntries = txParams.accessList.length;
  const maxStorageKeysPerEntry =
    maxAccessListEntries === 0 ? 0 : txParams.accessList[0].storageKeys.length;
  return persistentHash(new CompactTypeVector(2, BYTES_32), [
    REQUEST_ID_DOMAIN_TAG,
    persistentHash(
      signBidirectionalEventDescriptor(
        maxCalldataWords,
        maxAccessListEntries,
        maxStorageKeysPerEntry,
      ),
      request,
    ),
  ]);
}

// ---- Calldata / transaction assembly ----------------------------------------

/**
 * The 32-byte value of a NUMERIC ABI word (kinds staticArg / dynArgHead /
 * dynArgLength): the little-endian field embed of the number, exactly what
 * Compact's `x as Field as Bytes<32>` cast produces in-circuit. Use when
 * building words off-chain (UIs, expected-record builders, tests).
 *
 * @param value - The word's numeric value (amount, offset, length, ...).
 * @returns The 32-byte LE embed to store in {@link ABIWord.value}.
 */
export function numericAbiWordValue(value: bigint): Uint8Array {
  return bigintToBytes32(value);
}

/**
 * The 32-byte staticArg word value for an EVM address: the BIG-ENDIAN
 * numeric reading of its 20 display-order bytes, LE-embedded. TS mirror of
 * Signet.compact's `evmAddressAbiValue` circuit (+ `as Bytes<32>`); see the
 * warning there — embedding the display-order bytes directly would come out
 * byte-reversed in the assembled calldata.
 *
 * @param address - The 20-byte address in display order.
 * @returns The 32-byte word value to store in {@link ABIWord.value}.
 */
export function evmAddressAbiWord(address: Uint8Array): Uint8Array {
  let value = 0n;
  for (const byte of address) {
    value = value * 256n + BigInt(byte);
  }
  return bigintToBytes32(value);
}

/**
 * Re-assemble the raw calldata a request's tagged words describe:
 * `data = selector || processed words` in vector order, where each word's
 * {@link ABIWordKind} selects the processing — numeric kinds are LE-decoded
 * and re-encoded as big-endian 32-byte ABI words, dynArgData is copied
 * verbatim, unused is dropped. This is THE implementation of the MPC
 * re-assembly contract documented on `EVMCalldata` in Signet.compact.
 *
 * @param calldata - The request's calldata field.
 * @returns Hex calldata for the transaction (`"0x"` when absent).
 * @throws Error on an unknown word kind.
 */
export function assembleCalldata(calldata: Maybe<EVMCalldata>): string {
  if (!calldata.is_some) {
    return "0x";
  }
  let data = `0x${bytesToHex(calldata.value.selector)}`;
  for (const word of calldata.value.words) {
    switch (word.kind) {
      case ABIWordKind.staticArg:
      case ABIWordKind.dynArgHead:
      case ABIWordKind.dynArgLength:
        data += bytesToHex(bigintToBytes32BE(bytesToBigint(word.value)));
        break;
      case ABIWordKind.dynArgData:
        data += bytesToHex(word.value);
        break;
      case ABIWordKind.unused:
        break;
      default:
        throw new Error(`unknown ABI word kind ${word.kind}`);
    }
  }
  return data;
}

/**
 * Decode the real (count-trimmed) access list of a request into the shape
 * ethers' `Transaction.from` accepts.
 *
 * @param txParams - The request's transaction decomposition.
 * @returns The access list, possibly empty.
 */
function decodeAccessList(
  txParams: EVMType2TxParams,
): Array<{ address: string; storageKeys: string[] }> {
  return txParams.accessList
    .slice(0, Number(txParams.accessListEntryCount))
    .map((entry) => ({
      address: getAddress(`0x${bytesToHex(entry.address)}`),
      storageKeys: entry.storageKeys
        .slice(0, Number(entry.storageKeyCount))
        .map((key) => `0x${bytesToHex(key)}`),
    }));
}

/**
 * Rebuild the unsigned EIP-1559 transaction a request record describes,
 * byte-identical to the one the MPC assembles and signs: calldata from the
 * tagged words (see {@link assembleCalldata}), the count-trimmed access
 * list, and the stored envelope fields. This is the canonical
 * request→transaction transform; response-side verification
 * (`signature-response-verification.ts`) and the signed-transaction builder
 * below both go through it, so the transaction a client broadcasts is
 * provably the one the MPC put its signature over.
 *
 * @param event - The on-ledger request record.
 * @returns The unsigned ethers transaction (`unsignedHash` is the digest the
 *   MPC signs).
 * @throws Error if a calldata word carries an unknown kind.
 */
export function signBidirectionalEventToUnsignedEVMTransaction(
  event: SignBidirectionalEvent,
): Transaction {
  const { txParams } = event;
  return Transaction.from({
    type: 2,
    chainId: txParams.chainId,
    nonce: Number(txParams.nonce),
    gasLimit: txParams.gasLimit,
    maxFeePerGas: txParams.maxFeePerGas,
    maxPriorityFeePerGas: txParams.maxPriorityFeePerGas,
    to: getAddress(`0x${bytesToHex(txParams.to)}`),
    value: txParams.value,
    accessList: decodeAccessList(txParams),
    data: assembleCalldata(txParams.calldata),
  });
}

/**
 * Decode a response signature record (as posted to the signet contract's
 * signature response log — the canonical MPC `Signature { big_r, s,
 * recovery_id }` shape) into an ethers {@link Signature}: `r` is `bigR`'s x
 * coordinate, `v` the legacy parity derived from the recovery id.
 *
 * @param response - The posted signature record.
 * @returns The ethers signature.
 * @throws Error if the recovery id is not 0 or 1.
 */
export function signatureRespondedEventToSignature(
  response: SignatureRespondedEvent,
): Signature {
  const recoveryId = Number(response.recoveryId);
  if (recoveryId !== 0 && recoveryId !== 1) {
    throw new Error(`expected a recovery id of 0 or 1, got ${recoveryId}`);
  }
  return Signature.from({
    r: `0x${bytesToHex(response.bigRx)}`,
    s: `0x${bytesToHex(response.s)}`,
    v: recoveryId + 27,
  });
}

/** secp256k1 base field prime (2^256 - 2^32 - 977). */
const SECP256K1_P = 2n ** 256n - 2n ** 32n - 977n;

/** Modular exponentiation by squaring. */
function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

/** Encode a bigint as exactly 32 BIG-endian bytes (secp256k1 scalar form). */
function bigintToBytes32BE(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Encode an ECDSA signature as the response record posted to the signet
 * contract — the inverse of {@link signatureRespondedEventToSignature},
 * for MPC-side posters (the fakenet signer, tests). The canonical record
 * carries `bigR` as a full affine point but an `r || s || v` signature only
 * has R.x and the parity of R.y, so R.y is recovered by decompressing the
 * point on the curve (y² = x³ + 7 over the secp256k1 base field).
 *
 * The parameter is structural (the r/s/yParity subset of an ethers
 * {@link Signature}) so signatures from ANY ethers instance qualify — posters
 * living in other repos resolve their own ethers install, and nominal class
 * typing would reject it.
 *
 * @param signature - The signature to encode (`r`/`s` as 0x hex, `yParity` 0 or 1).
 * @returns The response record, ready to post.
 * @throws Error if `r` is not the x coordinate of a curve point.
 */
export function signatureToSignatureRespondedEvent(
  signature: Pick<Signature, "r" | "s" | "yParity">,
): SignatureRespondedEvent {
  const x = BigInt(signature.r);
  const ySquared = (modPow(x, 3n, SECP256K1_P) + 7n) % SECP256K1_P;
  // P ≡ 3 (mod 4), so a square root (when one exists) is c^((P+1)/4).
  let y = modPow(ySquared, (SECP256K1_P + 1n) / 4n, SECP256K1_P);
  if ((y * y) % SECP256K1_P !== ySquared) {
    throw new Error("signature r is not the x coordinate of a secp256k1 point");
  }
  if ((y & 1n) !== BigInt(signature.yParity)) {
    y = SECP256K1_P - y;
  }
  return {
    bigRx: getBytes(signature.r),
    bigRy: bigintToBytes32BE(y),
    s: getBytes(signature.s),
    recoveryId: BigInt(signature.yParity),
  };
}

/**
 * Assemble the broadcast-ready signed EIP-1559 transaction for a request from
 * its MPC signature response: rebuild the exact unsigned transaction the MPC
 * signed (see {@link signBidirectionalEventToUnsignedEVMTransaction}) and
 * attach the signature. Does NOT check that the signature recovers to the
 * requester's derived address — the response log is unauthenticated, so
 * verify first with `verifySignatureRespondedEvent`.
 *
 * @param event - The on-ledger request record.
 * @param response - The posted signature record answering it.
 * @returns The signed ethers transaction; `serialized` is the raw payload for
 *   `eth_sendRawTransaction`, `hash` its on-chain hash, `from` the recovered
 *   sender.
 * @throws Error if the request record is malformed (see
 *   {@link signBidirectionalEventToUnsignedEVMTransaction}) or the response
 *   is not a decodable signature.
 */
export function signBidirectionalEventToSignedEVMTransaction(
  event: SignBidirectionalEvent,
  response: SignatureRespondedEvent,
): Transaction {
  const transaction = signBidirectionalEventToUnsignedEVMTransaction(event);
  transaction.signature = signatureRespondedEventToSignature(response);
  return transaction;
}

/**
 * The generated ledger shape of `Map<RequestId, SignBidirectionalEvent>`:
 * what a contract's `ledger(state).signetRequestsIndex` provides. Structural,
 * so any contract exposing the index satisfies it.
 */
export interface SignBidirectionalEventLedgerIndex
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

/** Byte width of the path field (Compact `Bytes<256>`). */
export const PATH_BYTES = 256;

/**
 * Build the canonical MPC derivation path for an identity commitment: the
 * lowercase hex of the commitment as ASCII, zero-padded to {@link PATH_BYTES}
 * — exactly what the contract's `assertPathCommitment` accepts. Use this to
 * populate {@link SignBidirectionalEvent.path} when constructing requests.
 *
 * @param commitment - 32-byte identity commitment.
 * @returns The 256-byte path field value.
 */
export function signetPathOfCommitment(commitment: Uint8Array): Uint8Array {
  const path = new Uint8Array(PATH_BYTES);
  path.set(new TextEncoder().encode(bytesToHex(commitment)));
  return path;
}

/**
 * Parse the on-ledger request map into a plain-JS index keyed by hex
 * request id.
 *
 * @param ledgerIndex - Iterable of `[requestId, request]` entries — e.g. a
 *   contract's `ledger(state).signetRequestsIndex` (any
 *   {@link SignBidirectionalEventLedgerIndex}).
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
