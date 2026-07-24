// The EVM Type-2 (EIP-1559) instantiation of the signet request protocol:
// TypeScript twins of the `EVMType2TxParams` decomposition structs in
// `Signet.compact`, their runtime descriptors, the ABI-word helpers, and the
// request -> transaction assembly the signer runs. Everything chain-agnostic
// (the request record itself, ids, the descriptor toolkit) lives in
// `signet-requests.ts`; a future non-EVM decomposition gets a sibling of THIS
// file.
//
// The no-translation invariant lives here: words are stored ABI-ready and
// {@link assembleCalldata} concatenates `selector || words` VERBATIM, so the
// transaction the MPC signs carries the contract-stored bytes untouched.

import {
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  CompactTypeVector,
  persistentHash,
  type CompactType,
} from "@midnight-ntwrk/compact-runtime";
import { getAddress, Signature, toBeHex, Transaction } from "ethers";

import type { SignatureRespondedEvent } from "./signet-contract-state-reader.ts";
import {
  bigintToBytes32BE,
  ecdsaSignatureToMpcSignature,
  mpcSignatureToEcdsaSignature,
} from "./ecdsa-attestation.ts";
import {
  bytesToHex,
  compactMaybeDescriptor,
  compactStructDescriptor,
  signBidirectionalEventDescriptorWith,
  type Maybe,
  type RequestId,
  type SignBidirectionalEvent,
} from "./signet-requests.ts";

/**
 * ABI calldata as a 4-byte selector + 32-byte word slots (Compact:
 * `EVMCalldata<#maxWords>`). Every stored byte is ABI-READY: the calldata the
 * MPC signs is `selector || words[0..noWords]` VERBATIM (see
 * {@link assembleCalldata}), so words are big-endian broadcast-form ABI words,
 * built in-circuit by Signet.compact's `evmAddressAbiWord` / `numericAbiWord`.
 */
export interface EVMCalldata {
  /** The literal first 4 calldata bytes (as broadcast). */
  selector: Uint8Array;
  /** How many leading {@link words} are real (Compact `noWords: Uint<16>`). */
  noWords: bigint;
  /**
   * ABI-ready big-endian 32-byte word slots, stored exactly as broadcast;
   * capacity is the contract's `#maxWords` (vault: 2).
   */
  words: Uint8Array[];
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
  /** EVM chain id (also expressed in the record's `caip2Id`). */
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

// ---- Runtime descriptors (see the deviation note in signet-requests.ts) ----
// Base-type literals match what the compiler emits for the EVM structs'
// fields (Uint<8/16/64/128>, Bytes<4/20/32>).
const BYTES_4 = new CompactTypeBytes(4);
const BYTES_20 = new CompactTypeBytes(20);
const BYTES_32 = new CompactTypeBytes(32);
const UINT_8 = new CompactTypeUnsignedInteger(2n ** 8n - 1n, 1);
const UINT_16 = new CompactTypeUnsignedInteger(2n ** 16n - 1n, 2);
const UINT_64 = new CompactTypeUnsignedInteger(2n ** 64n - 1n, 8);
const UINT_128 = new CompactTypeUnsignedInteger(2n ** 128n - 1n, 16);

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
    noWords: UINT_16,
    words: new CompactTypeVector(maxWords, BYTES_32),
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
 * Descriptor of {@link SignBidirectionalEvent} at one EVM Type-2 capacity
 * instantiation — the generic record descriptor
 * (`signBidirectionalEventDescriptorWith`) over
 * {@link evmType2TxParamsDescriptor}.
 *
 * @param maxCalldataWords - Calldata word capacity.
 * @param maxAccessListEntries - Access-list entry capacity.
 * @param maxStorageKeysPerEntry - Storage-key capacity per entry.
 * @param lenOutputDeserialization - Declared byte width of
 *   `outputDeserializationSchema` (Compact `#LenOutputDeserialization`).
 * @param lenRespondSerialization - Declared byte width of
 *   `respondSerializationSchema` (Compact `#LenRespondSerialization`).
 * @returns The event record descriptor.
 */
export function signBidirectionalEventDescriptor(
  maxCalldataWords: number,
  maxAccessListEntries: number,
  maxStorageKeysPerEntry: number,
  lenOutputDeserialization: number,
  lenRespondSerialization: number,
): CompactType<SignBidirectionalEvent> {
  return signBidirectionalEventDescriptorWith(
    evmType2TxParamsDescriptor(
      maxCalldataWords,
      maxAccessListEntries,
      maxStorageKeysPerEntry,
    ),
    lenOutputDeserialization,
    lenRespondSerialization,
  );
}

/**
 * Canonical id of a signet request: the persistent hash of the entire event
 * record (which commits to every field, the sender address included — there
 * is deliberately no extra domain tag). TS twin of Signet.compact's
 * `calculateRequestId` circuit (see the deviation note in
 * signet-requests.ts), generic over the capacity instantiation via the
 * record's own array lengths — pass the record exactly as the ledger stores
 * it, unused slots included and schemas at their declared widths.
 *
 * @param request - The full event record (contract-shaped, all slots).
 * @returns The 32-byte request id — the record's ledger map key.
 */
export function calculateRequestId(request: SignBidirectionalEvent): RequestId {
  const { txParams } = request;
  const maxCalldataWords = txParams.calldata.value.words.length;
  const maxAccessListEntries = txParams.accessList.length;
  const maxStorageKeysPerEntry =
    maxAccessListEntries === 0 ? 0 : txParams.accessList[0].storageKeys.length;
  return persistentHash(
    signBidirectionalEventDescriptor(
      maxCalldataWords,
      maxAccessListEntries,
      maxStorageKeysPerEntry,
      request.outputDeserializationSchema.length,
      request.respondSerializationSchema.length,
    ),
    request,
  );
}

// ---- ABI words / calldata / transaction assembly ---------------------------

/**
 * The ABI word for a numeric value (e.g. an ERC20 amount): the value as a
 * 32-byte BIG-ENDIAN integer, exactly as broadcast. TS mirror of
 * Signet.compact's `numericAbiWord` circuit (lockstep-tested against the
 * compiled circuit). Use when building words off-chain (UIs, expected-record
 * builders, tests).
 *
 * @param value - The word's numeric value (e.g. an amount).
 * @returns The ABI-ready 32-byte word to store in an {@link EVMCalldata} word.
 * @throws Error if the value is negative or does not fit 32 bytes.
 */
export function numericAbiWord(value: bigint): Uint8Array {
  return bigintToBytes32BE(value);
}

/**
 * The ABI word for an EVM address: 12 zero bytes, then the 20 display-order
 * address bytes, exactly as broadcast. TS mirror of Signet.compact's
 * `evmAddressAbiWord` circuit (lockstep-tested against the compiled circuit).
 *
 * @param address - The 20-byte address in display order.
 * @returns The ABI-ready 32-byte word to store in an {@link EVMCalldata} word.
 * @throws Error if the address is not exactly 20 bytes.
 */
export function evmAddressAbiWord(address: Uint8Array): Uint8Array {
  if (address.length !== 20) {
    throw new Error(`EVM address must be 20 bytes, got ${address.length}`);
  }
  const word = new Uint8Array(32);
  word.set(address, 12);
  return word;
}

/**
 * The ABI word for a Boolean: 31 zero bytes, then 0x01 (true) or 0x00
 * (false). TS mirror of Signet.compact's `boolAbiWord` circuit
 * (lockstep-tested against the compiled circuit).
 *
 * @param value - The word's Boolean value.
 * @returns The ABI-ready 32-byte word to store in an {@link EVMCalldata} word.
 */
export function boolAbiWord(value: boolean): Uint8Array {
  const word = new Uint8Array(32);
  word[31] = value ? 1 : 0;
  return word;
}

/**
 * Read a numeric ABI word back into a bigint: the big-endian reading of bytes
 * 16..31. TS mirror of Signet.compact's `abiWordToUint128` circuit, including
 * its canonicality check: the leading 16 bytes must be zero, so a word wider
 * than Uint<128> is rejected rather than silently truncated.
 *
 * @param word - The ABI-ready 32-byte word.
 * @returns The word's numeric value.
 * @throws Error if the word is not 32 bytes or its leading half is nonzero.
 */
export function abiWordToUint128(word: Uint8Array): bigint {
  if (word.length !== 32) {
    throw new Error(`ABI word must be 32 bytes, got ${word.length}`);
  }
  if (word.slice(0, 16).some((byte) => byte !== 0)) {
    throw new Error("ABI word exceeds Uint<128>");
  }
  let value = 0n;
  for (let i = 16; i < 32; i++) {
    value = value * 256n + BigInt(word[i]);
  }
  return value;
}

/**
 * Read a Boolean ABI word back into a boolean. TS mirror of Signet.compact's
 * `abiWordToBool` circuit, including its canonicality check: the first 31
 * bytes must be zero and the last byte 0 or 1.
 *
 * @param word - The ABI-ready 32-byte word.
 * @returns The word's Boolean value.
 * @throws Error if the word is not 32 bytes or is not a canonical Boolean.
 */
export function abiWordToBool(word: Uint8Array): boolean {
  if (word.length !== 32) {
    throw new Error(`ABI word must be 32 bytes, got ${word.length}`);
  }
  if (word.slice(0, 31).some((byte) => byte !== 0) || word[31] > 1) {
    throw new Error("ABI word is not a canonical Boolean");
  }
  return word[31] === 1;
}

/**
 * Assemble the raw calldata a request's words describe:
 * `data = selector || words[0..noWords]`, VERBATIM. Words are stored
 * ABI-ready (see {@link EVMCalldata}), so no byte of the stored record is
 * reordered or reinterpreted on the way into the transaction; slots past
 * `noWords` are unused capacity and are dropped. This is THE implementation
 * of the signer-side assembly documented on `EVMCalldata` in Signet.compact.
 *
 * @param calldata - The request's calldata field.
 * @returns Hex calldata for the transaction (`"0x"` when absent).
 */
export function assembleCalldata(calldata: Maybe<EVMCalldata>): string {
  if (!calldata.is_some) {
    return "0x";
  }
  const { selector, noWords, words } = calldata.value;
  let data = `0x${bytesToHex(selector)}`;
  for (let i = 0; i < Number(noWords); i++) {
    data += bytesToHex(words[i]);
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
 * @param request - The on-ledger request record.
 * @returns The unsigned ethers transaction (`unsignedHash` is the digest the
 *   MPC signs).
 * @throws Error if a calldata word carries an unknown kind.
 */
export function signBidirectionalEventToUnsignedEVMTransaction(
  request: SignBidirectionalEvent,
): Transaction {
  const { txParams } = request;
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
 * signature response log) into an ethers {@link Signature}. Goes through
 * {@link mpcSignatureToEcdsaSignature} rather than reading the record's
 * fields directly, so this and in-circuit claims decode a post identically:
 * ethers' `r` is the ECDSA scalar (`bigR.x` reduced mod the curve order),
 * not the raw coordinate, and a malformed record is rejected the same way
 * in both paths.
 *
 * @param response - The posted signature record.
 * @returns The ethers signature.
 * @throws Error if the record is malformed (see {@link mpcSignatureToEcdsaSignature}).
 */
export function signatureRespondedEventToSignature(
  response: SignatureRespondedEvent,
): Signature {
  const { r, s, recoveryId } = mpcSignatureToEcdsaSignature(response.signature);
  return Signature.from({
    r: toBeHex(r, 32),
    s: toBeHex(s, 32),
    v: recoveryId + 27,
  });
}

/**
 * Encode an ECDSA signature as the response record posted to the signet
 * contract — the inverse of {@link signatureRespondedEventToSignature}, for
 * MPC-side posters (the fakenet signer, tests). An `r || s || v` signature
 * carries only R.x and the parity of R.y, so the full R point the record
 * stores is recovered on-curve (see {@link ecdsaSignatureToMpcSignature}).
 *
 * The parameter is structural (the r/s/yParity subset of an ethers
 * {@link Signature}) so signatures from ANY ethers instance qualify — posters
 * living in other repos resolve their own ethers install, and nominal class
 * typing would reject it.
 *
 * @param signature - The signature to encode (`r`/`s` as 0x hex, `yParity` 0 or 1).
 * @returns The response record, ready to post.
 * @throws Error if `r` is not the x coordinate of a secp256k1 point.
 */
export function signatureToSignatureRespondedEvent(
  signature: Pick<Signature, "r" | "s" | "yParity">,
): SignatureRespondedEvent {
  return {
    signature: ecdsaSignatureToMpcSignature({
      r: BigInt(signature.r),
      s: BigInt(signature.s),
      recoveryId: signature.yParity,
    }),
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
 * @param request - The on-ledger request record.
 * @param response - The posted signature record answering it.
 * @returns The signed ethers transaction; `serialized` is the raw payload for
 *   `eth_sendRawTransaction`, `hash` its on-chain hash, `from` the recovered
 *   sender.
 * @throws Error if the request record is malformed (see
 *   {@link signBidirectionalEventToUnsignedEVMTransaction}) or the response
 *   is not a decodable signature.
 */
export function signBidirectionalEventToSignedEVMTransaction(
  request: SignBidirectionalEvent,
  response: SignatureRespondedEvent,
): Transaction {
  const transaction = signBidirectionalEventToUnsignedEVMTransaction(request);
  transaction.signature = signatureRespondedEventToSignature(response);
  return transaction;
}
