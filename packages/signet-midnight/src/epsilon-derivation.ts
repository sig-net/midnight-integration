// Epsilon key derivation: contract address + path -> derived key and its EVM account.
//
// This belongs in github.com/sig-net/signet.js, kept here until upstreamed.
//
// v2.0.0 (COLON-separated) is the only scheme the MPC answers: the Compact
// contracts assert `keyVersion >= 1`, which selects v2.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { computeAddress, keccak256, toUtf8Bytes } from "ethers";

import { bigintToBytes32BE, bytesToBigintBE, bytesToHex, stripHexPrefix } from "./byte-codecs.ts";
import {
  formatSecp256k1PublicKey,
  parseSecp256k1PublicKeyToNoblePoint,
  SECP256K1_ORDER,
  type Secp256k1Point,
} from "./ecdsa-attestation.ts";
import type { SignBidirectionalEvent } from "./signet-requests.ts";

/**
 * Domain prefix of the sig-net v2.0.0 epsilon derivation scheme. The full
 * derivation string is `<prefix>:midnight:mainnet:<requester>:<path>`
 * (colon-separated), matching `caip2_derivation_path` in the MPC's
 * `signet-crypto/src/kdf.rs`.
 */
export const EPSILON_DERIVATION_PREFIX = "sig.network v2.0.0 epsilon derivation";

/**
 * CAIP-2 chain id component of every Midnight derivation string. The MPC
 * renders `Chain::Midnight` as this one literal for every Midnight network
 * (sig-net/mpc signet-primitives/src/chain.rs), so it never varies with the
 * network a contract is deployed on.
 */
export const MIDNIGHT_CAIP2_ID = "midnight:mainnet";

/**
 * The FIXED derivation path of the MPC's respond-bidirectional RESPONSE key
 * for Midnight client contracts. It enters the derivation string verbatim,
 * mirroring the real MPC's per-chain `<chain> response key` convention
 * (sig-net/mpc chain-signatures/node/src/respond_bidirectional.rs). The
 * response key is derived PER CLIENT CONTRACT from (the client contract's
 * own address, this path): it is not the MPC root key and not the key that
 * signs the requested transaction. Client contracts pin its hash with a
 * one-shot `initialise` circuit after deploy and verify
 * RespondBidirectionalEvents against the pin.
 */
export const MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH = "midnight response key";

/**
 * The two fields of a request record that select its request signing key.
 * The record's tx-params decomposition plays no part, so a record over any
 * decomposition satisfies it.
 */
export type SignBidirectionalEventKeySelector = Pick<SignBidirectionalEvent, "sender" | "path">;

/**
 * Normalise a Midnight contract address for use as the requester component
 * of the derivation string: strip an optional `0x` prefix and lowercase.
 * Both sides of the protocol (the deploy pinning a key and the MPC signing
 * with it) derive through this, so the rendering always agrees.
 *
 * @param contractAddress - The Midnight contract address, with or without `0x`.
 * @returns The address as lowercase hex with no prefix.
 */
function normaliseRequesterAddress(contractAddress: string): string {
  return stripHexPrefix(contractAddress).toLowerCase();
}

/**
 * Derive the REQUEST SIGNING key: the public key the MPC network signs a
 * Midnight contract's requested transactions with, using the sig-net v2.0.0
 * epsilon scheme:
 * `epsilon = keccak256("<prefix>:midnight:mainnet:<requester>:<path>")` and
 * `derivedPubKey = mpcRootPubKey + epsilon * G` on secp256k1. The MPC
 * treats `path` as an opaque string. For a request record already in hand,
 * {@link deriveSignBidirectionalEventSigningKey} renders the two record
 * fields itself.
 *
 * @param mpcSecp256k1PublicKey - The MPC root secp256k1 public key, in any
 *   spelling `parseSecp256k1PublicKey` accepts (SEC1 hex or NEAR
 *   `secp256k1:<base58>`).
 * @param contractAddress - The Midnight contract address the request
 *   originates from (`0x` prefix optional, case-insensitive: it enters the
 *   derivation string through {@link normaliseRequesterAddress}).
 * @param path - The derivation path string. For a key derived from an
 *   on-ledger request record, this is the MPC's rendering of the record's
 *   `path: Bytes<32>`: the lowercase hex of the FULL 32 bytes, no `0x`
 *   prefix and no trimming ({@link bytesToHex} of the raw bytes), so
 *   `0xab..00` and `0xab..` derive different keys.
 * @returns The request signing public key as a Compact-runtime
 *   `Secp256k1Point`.
 */
export function deriveMidnightRequestSigningKey(
  mpcSecp256k1PublicKey: string,
  contractAddress: string,
  path: string,
): Secp256k1Point {
  return deriveChildKey(mpcSecp256k1PublicKey, normaliseRequesterAddress(contractAddress), path);
}

/**
 * Derive the EVM address of the request signing key (see
 * {@link deriveMidnightRequestSigningKey}): the account the MPC network
 * signs from for a given Midnight contract and derivation path.
 *
 * @param mpcSecp256k1PublicKey - The MPC root secp256k1 public key, in any
 *   spelling `parseSecp256k1PublicKey` accepts (SEC1 hex or NEAR
 *   `secp256k1:<base58>`).
 * @param contractAddress - The Midnight contract address the request
 *   originates from (`0x` prefix optional, case-insensitive: it enters the
 *   derivation string through {@link normaliseRequesterAddress}).
 * @param path - The derivation path string. For an account derived from an
 *   on-ledger request record, this is the MPC's rendering of the record's
 *   `path: Bytes<32>`: the lowercase hex of the FULL 32 bytes, no `0x`
 *   prefix and no trimming ({@link bytesToHex} of the raw bytes), so
 *   `0xab..00` and `0xab..` derive different accounts.
 * @returns The derived EVM address as a 0x-prefixed EIP-55 checksummed string.
 */
export function deriveEvmAddress(
  mpcSecp256k1PublicKey: string,
  contractAddress: string,
  path: string,
): string {
  return computeAddress(
    formatSecp256k1PublicKey(
      deriveMidnightRequestSigningKey(mpcSecp256k1PublicKey, contractAddress, path),
    ),
  );
}

/**
 * Derive the request signing key of an on-ledger request record: the public
 * key the MPC signs THAT request's transaction with. Owns the MPC's
 * rendering of the record into the derivation string: the requester is the
 * record's `sender`, and the path is the lowercase hex of its FULL 32
 * `path` bytes.
 *
 * @param mpcSecp256k1PublicKey - The MPC root secp256k1 public key of the
 *   record's `keyVersion`, in any spelling `parseSecp256k1PublicKey`
 *   accepts (SEC1 hex or NEAR `secp256k1:<base58>`).
 * @param request - The on-ledger request record, or its `sender` and `path`.
 * @returns The request signing public key as a Compact-runtime
 *   `Secp256k1Point`.
 */
export function deriveSignBidirectionalEventSigningKey(
  mpcSecp256k1PublicKey: string,
  request: SignBidirectionalEventKeySelector,
): Secp256k1Point {
  return deriveMidnightRequestSigningKey(
    mpcSecp256k1PublicKey,
    bytesToHex(request.sender.bytes),
    bytesToHex(request.path),
  );
}

/**
 * Derive the EVM address of an on-ledger request record's request signing
 * key (see {@link deriveSignBidirectionalEventSigningKey}): the signer a
 * response to that request must recover to.
 *
 * @param mpcSecp256k1PublicKey - The MPC root secp256k1 public key of the
 *   record's `keyVersion`, in any spelling `parseSecp256k1PublicKey`
 *   accepts (SEC1 hex or NEAR `secp256k1:<base58>`).
 * @param request - The on-ledger request record, or its `sender` and `path`.
 * @returns The derived EVM address as a 0x-prefixed EIP-55 checksummed string.
 */
export function deriveSignBidirectionalEventSignerEvmAddress(
  mpcSecp256k1PublicKey: string,
  request: SignBidirectionalEventKeySelector,
): string {
  return computeAddress(
    formatSecp256k1PublicKey(
      deriveSignBidirectionalEventSigningKey(mpcSecp256k1PublicKey, request),
    ),
  );
}

/**
 * The epsilon scalar of the sig-net v2.0.0 derivation scheme:
 * `keccak256("<prefix>:midnight:mainnet:<requester>:<path>")` reduced mod
 * the secp256k1 curve order, the chain id fixed to
 * {@link MIDNIGHT_CAIP2_ID}. Child keys are `root + epsilon` (secret side) and
 * `rootPubKey + epsilon * G` (public side).
 *
 * @param requester - The requester component of the derivation string,
 *   verbatim (no normalisation: callers must agree on the exact rendering).
 * @param path - The derivation path string.
 * @returns The epsilon scalar, in `[0, n)`.
 */
export function deriveEpsilon(requester: string, path: string): bigint {
  const fullPath = `${EPSILON_DERIVATION_PREFIX}:${MIDNIGHT_CAIP2_ID}:${requester}:${path}`;
  // Reduce mod n before using: noble throws on scalars >= n, whereas the
  // server's scalar arithmetic reduces implicitly.
  return BigInt(keccak256(toUtf8Bytes(fullPath))) % SECP256K1_ORDER;
}

/**
 * Derive the child public key `rootPubKey + epsilon * G`.
 *
 * @param mpcSecp256k1PublicKey - The MPC root public key, any spelling
 *   `parseSecp256k1PublicKey` accepts.
 * @param requester - The normalised requester address.
 * @param path - The derivation path component.
 * @returns The derived child public key.
 */
function deriveChildKey(
  mpcSecp256k1PublicKey: string,
  requester: string,
  path: string,
): Secp256k1Point {
  const epsilon = deriveEpsilon(requester, path);
  const rootPoint = parseSecp256k1PublicKeyToNoblePoint(mpcSecp256k1PublicKey);
  const childPoint =
    epsilon === 0n ? rootPoint : rootPoint.add(secp256k1.Point.BASE.multiply(epsilon));
  return { x: childPoint.x, y: childPoint.y, identity: false };
}

/**
 * Derive the MPC's respond-bidirectional RESPONSE key for one client
 * contract, public side: what the client pins via its `initialise` circuit
 * and what response verification checks against. See
 * {@link MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH} for the scheme.
 *
 * @param mpcSecp256k1PublicKey - The MPC root secp256k1 public key, in any
 *   spelling `parseSecp256k1PublicKey` accepts (SEC1 hex or NEAR
 *   `secp256k1:<base58>`).
 * @param clientContractAddress - The client contract's Midnight address
 *   (`0x` prefix optional, case-insensitive).
 * @returns The response public key as a Compact-runtime `Secp256k1Point`.
 */
export function deriveMidnightResponseKey(
  mpcSecp256k1PublicKey: string,
  clientContractAddress: string,
): Secp256k1Point {
  return deriveChildKey(
    mpcSecp256k1PublicKey,
    normaliseRequesterAddress(clientContractAddress),
    MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH,
  );
}

/**
 * Derive the MPC's respond-bidirectional RESPONSE key for one client
 * contract, secret side: `(rootSecret + epsilon) mod n`. MPC-side only
 * (the fakenet signer, test harnesses): a real client never holds the root
 * key.
 *
 * @param mpcRootSecretKey - The 32-byte MPC root secret key (big-endian).
 * @param clientContractAddress - The client contract's Midnight address
 *   (`0x` prefix optional, case-insensitive).
 * @returns The 32-byte response secret key (big-endian).
 * @throws {Error} If the root key is not 32 bytes or the derived scalar is 0.
 */
export function deriveMidnightResponseSecretKey(
  mpcRootSecretKey: Uint8Array,
  clientContractAddress: string,
): Uint8Array {
  if (mpcRootSecretKey.length !== 32) {
    throw new Error(`MPC root secret key must be 32 bytes, got ${String(mpcRootSecretKey.length)}`);
  }
  const root = bytesToBigintBE(mpcRootSecretKey);
  const epsilon = deriveEpsilon(
    normaliseRequesterAddress(clientContractAddress),
    MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH,
  );
  const child = (root + epsilon) % SECP256K1_ORDER;
  if (child === 0n) {
    throw new Error("derived response secret key is zero (invalid scalar)");
  }
  return bigintToBytes32BE(child);
}
