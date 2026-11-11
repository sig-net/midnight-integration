import { decodeBase58, encodeBase58, getBytes, sha256, toBeArray } from "ethers";

import { bigintToBytes32BE, hexToBytes, stripHexPrefix } from "./byte-codecs.ts";
import { mpcSignatureToEcdsaSignature } from "./ecdsa-attestation.ts";
import { deriveEvmAddress } from "./epsilon-derivation.ts";
import { pureCircuits } from "./managed/contract/index.js";
import type { MpcSignature } from "./signet-contract-events.ts";
import type { TronTxParams } from "./signet-tron-requests.ts";

const TRON_ADDRESS_PREFIX = 0x41;

const TRON_ADDRESS_BYTES = 21;

function assertTronAddress(address: Uint8Array, name: string): void {
  if (address.length !== TRON_ADDRESS_BYTES || address[0] !== TRON_ADDRESS_PREFIX) {
    throw new Error(`${name} must be 21 bytes with the 0x41 prefix`);
  }
}

/**
 * @param evm - The 20-byte EVM address, as bytes or hex (optional `0x`, any case)
 * @returns The 21-byte Tron address
 * @throws {Error} If the input is not exactly 20 bytes
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

function base58CheckChecksum(address: Uint8Array): Uint8Array {
  return getBytes(sha256(sha256(address))).slice(0, 4);
}

/**
 * @param address - The 21-byte, `0x41`-prefixed Tron address
 * @returns The base58check text
 * @throws {Error} If the address has the wrong length or prefix
 */
export function tronAddressToBase58(address: Uint8Array): string {
  assertTronAddress(address, "Tron address");
  return encodeBase58(Uint8Array.from([...address, ...base58CheckChecksum(address)]));
}

/**
 * @param text - The base58check text (`T…`)
 * @returns The 21-byte Tron address
 * @throws {Error} If the text is not base58, not 25 bytes, fails its checksum or does not carry the `0x41` prefix
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

/** */
export interface TronAddress {
  bytes: Uint8Array;
  base58: string;
}

/**
 * @param mpcSecp256k1PublicKey - The MPC root secp256k1 public key, in any spelling `parseSecp256k1PublicKey` accepts
 * @param contractAddress - The Midnight contract address the request originates from (`0x` prefix optional, case-insensitive)
 * @param path - The derivation path string
 * @returns The derived address in both forms
 */
export function deriveTronAddress(
  mpcSecp256k1PublicKey: string,
  contractAddress: string,
  path: string,
): TronAddress {
  const bytes = tronAddressFromEvm(deriveEvmAddress(mpcSecp256k1PublicKey, contractAddress, path));
  return { bytes, base58: tronAddressToBase58(bytes) };
}

const TRIGGER_SMART_CONTRACT_TYPE_URL = "type.googleapis.com/protocol.TriggerSmartContract";

const TRIGGER_SMART_CONTRACT_TYPE = 31n;

const INT64_LIMIT = 2n ** 63n;

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

function varintField(field: number, value: bigint): number[] {
  return value === 0n ? [] : [...varint(BigInt(field << 3)), ...varint(value)];
}

function int64Field(field: number, value: bigint, name: string): number[] {
  if (value < 0n || value >= INT64_LIMIT) {
    throw new Error(`${name} ${String(value)} exceeds the int64 wire field`);
  }
  return varintField(field, value);
}

function lengthDelimitedField(field: number, bytes: Uint8Array | readonly number[]): number[] {
  return [...varint(BigInt((field << 3) | 2)), ...varint(BigInt(bytes.length)), ...bytes];
}

function bytesField(field: number, bytes: Uint8Array | readonly number[]): number[] {
  return bytes.length === 0 ? [] : lengthDelimitedField(field, bytes);
}

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
 * @param params - The request's transaction parameters
 * @param owner - The 21-byte Tron address of the request signing key (see {@link deriveTronAddress})
 * @returns The raw transaction bytes
 * @throws {Error} If a field cannot be represented
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
 * @param raw - The raw transaction bytes ({@link buildTronRawTransaction})
 * @returns The 32-byte transaction id
 */
export function tronTransactionId(raw: Uint8Array): Uint8Array {
  return getBytes(sha256(raw));
}

/**
 * @param raw - The raw transaction bytes ({@link buildTronRawTransaction})
 * @param signature - The signature as the MPC posts it
 * @returns The signed transaction bytes
 * @throws {Error} If the signature is malformed (see `mpcSignatureToEcdsaSignature`)
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
