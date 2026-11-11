// Tron addresses and the TriggerSmartContract transaction a Tron request
// describes, assembled byte for byte as the MPC assembles it (sig-net/mpc
// chain-signatures/tron-wire: `to_unsigned_tron_tx` and
// `RawTransaction::sign_and_hash`). The protobuf encoder covers only the
// fields that assembly sets: proto3 omits zero integers and empty bytes, and
// writes fields in tag order.

import { decodeBase58, encodeBase58, getBytes, sha256, toBeArray } from "ethers";

import { bigintToBytes32BE, hexToBytes, stripHexPrefix } from "./byte-codecs.ts";
import { mpcSignatureToEcdsaSignature } from "./ecdsa-attestation.ts";
import { deriveEvmAddress } from "./epsilon-derivation.ts";
import { pureCircuits } from "./managed/contract/index.js";
import type { MpcSignature } from "./signet-contract-events.ts";
import type { TronTxParams } from "./signet-tron-requests.ts";

/** First byte of every 21-byte Tron address. */
const TRON_ADDRESS_PREFIX = 0x41;

/** Byte width of a Tron address: the prefix and the 20-byte EVM address. */
const TRON_ADDRESS_BYTES = 21;

/**
 * Throw unless `address` is a 21-byte, `0x41`-prefixed Tron address.
 *
 * @param address - The candidate address.
 * @param name - Error-message subject.
 * @throws {Error} If the address has the wrong length or prefix.
 */
function assertTronAddress(address: Uint8Array, name: string): void {
  if (address.length !== TRON_ADDRESS_BYTES || address[0] !== TRON_ADDRESS_PREFIX) {
    throw new Error(`${name} must be 21 bytes with the 0x41 prefix`);
  }
}

/**
 * The 21-byte Tron form of an EVM address: `0x41` followed by its 20 bytes,
 * computed by the compiled `tronAddress` circuit.
 *
 * @param evm - The 20-byte EVM address, as bytes or hex (optional `0x`, any case).
 * @returns The 21-byte Tron address.
 * @throws {Error} If the input is not exactly 20 bytes.
 */
export function tronAddressFromEvm(evm: string | Uint8Array): Uint8Array {
  if (typeof evm === "string") {
    const digits = stripHexPrefix(evm);
    if (!/^[0-9a-fA-F]{40}$/.test(digits)) {
      throw new Error(`not a 20-byte EVM address in hex: "${evm}"`);
    }
    return pureCircuits.tronAddress(hexToBytes(digits));
  }
  if (evm.length !== 20) {
    throw new Error(`EVM address must be 20 bytes, got ${String(evm.length)}`);
  }
  return pureCircuits.tronAddress(evm);
}

/**
 * The base58check checksum of a Tron address: the first four bytes of
 * sha256(sha256(address)).
 *
 * @param address - The 21-byte address.
 * @returns The 4-byte checksum.
 */
function base58CheckChecksum(address: Uint8Array): Uint8Array {
  return getBytes(sha256(sha256(address))).slice(0, 4);
}

/**
 * Render a Tron address in its wallet form: base58check of the 21 bytes
 * (`T…`).
 *
 * @param address - The 21-byte, `0x41`-prefixed Tron address.
 * @returns The base58check text.
 * @throws {Error} If the address has the wrong length or prefix.
 */
export function tronAddressToBase58(address: Uint8Array): string {
  assertTronAddress(address, "Tron address");
  return encodeBase58(Uint8Array.from([...address, ...base58CheckChecksum(address)]));
}

/**
 * Parse a Tron address from its wallet form: the inverse of
 * {@link tronAddressToBase58}.
 *
 * @param text - The base58check text (`T…`).
 * @returns The 21-byte Tron address.
 * @throws {Error} If the text is not base58, not 25 bytes, fails its
 *   checksum or does not carry the `0x41` prefix.
 */
export function tronAddressFromBase58(text: string): Uint8Array {
  let decoded: Uint8Array;
  try {
    decoded = toBeArray(decodeBase58(text));
  } catch (error) {
    throw new Error(`not a base58 Tron address: "${text}"`, { cause: error });
  }
  if (decoded.length !== TRON_ADDRESS_BYTES + 4) {
    throw new Error(`expected 25 bytes (21 payload + 4 checksum), got ${String(decoded.length)}`);
  }
  const address = decoded.slice(0, TRON_ADDRESS_BYTES);
  const checksum = decoded.slice(TRON_ADDRESS_BYTES);
  if (!base58CheckChecksum(address).every((byte, index) => byte === checksum[index])) {
    throw new Error("base58check checksum mismatch");
  }
  assertTronAddress(address, "Tron address");
  return address;
}

/** A Tron address in its byte and wallet forms. */
export interface TronAddress {
  /** The 21-byte, `0x41`-prefixed address. */
  bytes: Uint8Array;
  /** The base58check wallet form (`T…`). */
  base58: string;
}

/**
 * Derive the Tron address of a request signing key: the owner the MPC
 * assembles and signs a Tron request's transaction from. The key is the one
 * `deriveEvmAddress` derives, so the address is that EVM address in Tron
 * form.
 *
 * @param mpcSecp256k1PublicKey - The MPC root secp256k1 public key, in any
 *   spelling `parseSecp256k1PublicKey` accepts.
 * @param contractAddress - The Midnight contract address the request
 *   originates from (`0x` prefix optional, case-insensitive).
 * @param path - The derivation path string: for an on-ledger record, the
 *   lowercase hex of its full 32 `path` bytes.
 * @returns The derived address in both forms.
 */
export function deriveTronAddress(
  mpcSecp256k1PublicKey: string,
  contractAddress: string,
  path: string,
): TronAddress {
  const bytes = tronAddressFromEvm(deriveEvmAddress(mpcSecp256k1PublicKey, contractAddress, path));
  return { bytes, base58: tronAddressToBase58(bytes) };
}

/** The `Any.type_url` of a `TriggerSmartContract` parameter. */
const TRIGGER_SMART_CONTRACT_TYPE_URL = "type.googleapis.com/protocol.TriggerSmartContract";

/** `Transaction.Contract.ContractType.TriggerSmartContract`. */
const TRIGGER_SMART_CONTRACT_TYPE = 31n;

/** One past the largest value an int64 wire field carries. */
const INT64_LIMIT = 2n ** 63n;

/**
 * Protobuf base-128 varint of a non-negative integer.
 *
 * @param value - The integer, below 2^64.
 * @returns The varint bytes.
 */
function varint(value: bigint): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80n) {
    out.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  out.push(Number(rest));
  return out;
}

/**
 * A varint-typed field (wire type 0), omitted at zero as proto3 omits it.
 *
 * @param field - The field number.
 * @param value - The non-negative value.
 * @returns The encoded field, empty for zero.
 */
function varintField(field: number, value: bigint): number[] {
  return value === 0n ? [] : [...varint(BigInt(field << 3)), ...varint(value)];
}

/**
 * An int64 field holding a non-negative value.
 *
 * @param field - The field number.
 * @param value - The value.
 * @param name - Error-message subject.
 * @returns The encoded field, empty for zero.
 * @throws {Error} If the value is negative or does not fit int64.
 */
function int64Field(field: number, value: bigint, name: string): number[] {
  if (value < 0n || value >= INT64_LIMIT) {
    throw new Error(`${name} ${String(value)} exceeds the int64 wire field`);
  }
  return varintField(field, value);
}

/**
 * A length-delimited field (wire type 2) written even when empty: an embedded
 * message that is present, or one element of a repeated field.
 *
 * @param field - The field number.
 * @param bytes - The field's payload.
 * @returns The encoded field.
 */
function lengthDelimitedField(field: number, bytes: Uint8Array | readonly number[]): number[] {
  return [...varint(BigInt((field << 3) | 2)), ...varint(BigInt(bytes.length)), ...bytes];
}

/**
 * A singular `bytes` or `string` field, omitted when empty as proto3 omits it.
 *
 * @param field - The field number.
 * @param bytes - The field's payload.
 * @returns The encoded field, empty for an empty payload.
 */
function bytesField(field: number, bytes: Uint8Array | readonly number[]): number[] {
  return bytes.length === 0 ? [] : lengthDelimitedField(field, bytes);
}

/**
 * The call data a Tron request names: `selector || words[0..noWords]` when
 * present, empty otherwise.
 *
 * @param params - The request's transaction parameters.
 * @returns The call data bytes.
 * @throws {Error} If the word count exceeds the stored words.
 */
function tronCalldata(params: TronTxParams): number[] {
  if (!params.calldata.is_some) {
    return [];
  }
  const { selector, noWords, words } = params.calldata.value;
  if (noWords > BigInt(words.length)) {
    throw new Error(
      `calldata noWords ${String(noWords)} exceeds the capacity of ${String(words.length)}`,
    );
  }
  return [...selector, ...words.slice(0, Number(noWords)).flatMap((word) => [...word])];
}

/**
 * Assemble the protobuf `Transaction.raw` bytes of a Tron request, exactly as
 * the MPC assembles and signs them: one `TriggerSmartContract` whose
 * `owner_address` is the request's derived key and every other field from
 * `params`. Its sha256 is the transaction id ({@link tronTransactionId}).
 *
 * @param params - The request's transaction parameters.
 * @param owner - The 21-byte Tron address of the request signing key (see
 *   {@link deriveTronAddress}).
 * @returns The raw transaction bytes.
 * @throws {Error} If a field cannot be represented: a reference field of the
 *   wrong width, a zero expiration, an address that is not 21 bytes with the
 *   `0x41` prefix, a value past int64 or a word count past the stored words.
 */
export function buildTronRawTransaction(params: TronTxParams, owner: Uint8Array): Uint8Array {
  if (params.refBlockBytes.length !== 2) {
    throw new Error("refBlockBytes must be TaPoS' two bytes");
  }
  if (params.refBlockHash.length !== 8) {
    throw new Error("refBlockHash must be TaPoS' eight bytes");
  }
  if (params.expiration === 0n) {
    throw new Error("missing expiration");
  }
  assertTronAddress(owner, "owner address");
  assertTronAddress(params.contractAddress, "contract address");
  const trigger = [
    ...bytesField(1, owner),
    ...bytesField(2, params.contractAddress),
    ...int64Field(3, params.callValue, "callValue"),
    ...bytesField(4, tronCalldata(params)),
  ];
  const parameter = [
    ...bytesField(1, new TextEncoder().encode(TRIGGER_SMART_CONTRACT_TYPE_URL)),
    ...bytesField(2, trigger),
  ];
  const contract = [
    ...varintField(1, TRIGGER_SMART_CONTRACT_TYPE),
    ...lengthDelimitedField(2, parameter),
  ];
  return Uint8Array.from([
    ...bytesField(1, params.refBlockBytes),
    ...bytesField(4, params.refBlockHash),
    ...int64Field(8, params.expiration, "expiration"),
    ...lengthDelimitedField(11, contract),
    ...int64Field(14, params.timestamp, "timestamp"),
    ...int64Field(18, params.feeLimit, "feeLimit"),
  ]);
}

/**
 * The id of a Tron transaction: sha256 of its raw bytes. It is also the
 * digest the MPC signs.
 *
 * @param raw - The raw transaction bytes ({@link buildTronRawTransaction}).
 * @returns The 32-byte transaction id.
 */
export function tronTransactionId(raw: Uint8Array): Uint8Array {
  return getBytes(sha256(raw));
}

/**
 * Wrap raw transaction bytes and the MPC's signature into the broadcast-ready
 * protobuf `Transaction`: the raw message and one 65-byte `r || s || v`
 * signature with `v` the recovery id (0 or 1). Does NOT check that the
 * signature recovers to the owner: verify first with
 * `verifyTronSignatureRespondedEvent`.
 *
 * @param raw - The raw transaction bytes ({@link buildTronRawTransaction}).
 * @param signature - The signature as the MPC posts it.
 * @returns The signed transaction bytes.
 * @throws {Error} If the signature is malformed (see
 *   `mpcSignatureToEcdsaSignature`).
 */
export function buildSignedTronTransaction(raw: Uint8Array, signature: MpcSignature): Uint8Array {
  const { r, s, recoveryId } = mpcSignatureToEcdsaSignature(signature);
  const signatureBytes = Uint8Array.from([
    ...bigintToBytes32BE(r),
    ...bigintToBytes32BE(s),
    recoveryId,
  ]);
  return Uint8Array.from([
    ...lengthDelimitedField(1, raw),
    ...lengthDelimitedField(2, signatureBytes),
  ]);
}
