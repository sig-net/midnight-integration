// secp256k1 ECDSA helpers — the TS side of the shared attestation flow:
// SIGNING (which needs the secret scalar, so it cannot be a circuit), key
// parsing/formatting/hashing, and the little-endian scalar-byte plumbing the
// ledger struct stores. Everything provable stays in Compact: the attestation
// message is the COMPILED `pureCircuits.signetAttestationMessage` (this file
// never re-implements it) and verification is CompactStandardLibrary's
// `secp256k1EcdsaVerify`, run by the signet contract at post time and by the
// caller at settle time.
//
// This belongs in github.com/sig-net/signet.js as its Midnight adapter —
// kept here until upstreamed. It is Midnight-specific only in the point-hash
// form (`persistentHash<Secp256k1Point>` via @midnight-ntwrk/compact-runtime),
// which is exactly the deploy-time key pin the contracts seal.

import { secp256k1 } from "@noble/curves/secp256k1.js";

import {
  CompactTypeSecp256k1Point,
  persistentHash,
  type Secp256k1Point,
} from "@midnight-ntwrk/compact-runtime";

// Re-exported because it appears throughout this module's public signatures
// (parse/format/hashSecp256k1Point, signAttestation's key point) — SDK
// consumers shouldn't have to depend on compact-runtime just for the type.
export type { Secp256k1Point } from "@midnight-ntwrk/compact-runtime";

/** secp256k1 curve (group) order n — the scalar field the signature r, s live in. */
export const SECP256K1_ORDER = secp256k1.Point.Fn.ORDER;

/**
 * BLS12-381 scalar field order (the Compact `Field` type modulus). Retained
 * because {@link bigintToBytes32} interprets negative `Field` values in it and
 * signet-requests.ts imports the byte helpers below.
 */
export const BLS_ORDER = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;

/**
 * Convert little-endian bytes to a bigint. Matches Compact's
 * `Bytes<32> as Field` / `Bytes<32> as Secp256k1Scalar` interpretation (and
 * the MPC monitor's ABI-word decoding convention).
 *
 * @param bytes - Little-endian byte array.
 * @returns The decoded non-negative integer.
 */
export function bytesToBigint(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

/**
 * Convert a bigint to exactly 32 little-endian bytes. Matches Compact's
 * `Field as Bytes<32>` / `Secp256k1Scalar as Bytes<32>` encoding (the inverse
 * of {@link bytesToBigint}); negative inputs are interpreted in the BLS scalar
 * field.
 *
 * @param n - The integer to encode.
 * @returns The 32-byte little-endian encoding.
 */
export function bigintToBytes32(n: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let v = n < 0n ? n + BLS_ORDER : n;
  for (let i = 0; i < 32; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/**
 * An ECDSA signature over the attestation digest (TS twin of
 * CompactStandardLibrary's `Secp256k1EcdsaSignature`). Both scalars are plain
 * bigints mod {@link SECP256K1_ORDER}; convert to the ledger form with
 * {@link ecdsaSignatureToLeBytes}.
 */
export interface EcdsaSignature {
  /** Signature scalar r. */
  r: bigint;
  /** Signature scalar s (low-s normalized by {@link signAttestation}). */
  s: bigint;
}

/**
 * The little-endian 32-byte scalar encoding of an {@link EcdsaSignature} — the
 * exact `sigR`/`sigS` bytes the Compact `RespondBidirectional` struct stores
 * (the byte order the `Secp256k1Scalar as Bytes<32>` cast produces).
 */
export interface EcdsaSignatureBytes {
  /** Signature scalar r as 32 little-endian bytes. */
  sigR: Uint8Array;
  /** Signature scalar s as 32 little-endian bytes. */
  sigS: Uint8Array;
}

/**
 * Sign a 32-byte attestation digest with secp256k1 ECDSA, matching
 * CompactStandardLibrary's `secp256k1EcdsaVerify`: the digest IS the message
 * hash (interpreted big-endian, RFC 6979), so signing is `prehash: false` —
 * noble must not re-hash it. The digest is the compiled
 * `pureCircuits.signetAttestationMessage(requestId, serializedOutput,
 * outputLen)`. noble normalizes to low-s by default; the verifier accepts
 * either s, so this is a convention, not a requirement.
 *
 * @param digest - The 32-byte attestation digest to sign.
 * @param secretKey - The 32-byte secp256k1 private key (the MPC root key).
 * @returns The signature `{ r, s }`.
 */
export function signAttestation(
  digest: Uint8Array,
  secretKey: Uint8Array,
): EcdsaSignature {
  const signature = secp256k1.Signature.fromBytes(
    secp256k1.sign(digest, secretKey, { prehash: false }),
    "compact",
  );
  return { r: signature.r, s: signature.s };
}

/**
 * Encode an {@link EcdsaSignature}'s scalars as the little-endian 32-byte
 * `sigR`/`sigS` the Compact `RespondBidirectional` struct stores — the form
 * the verifying circuits cast back with `as Secp256k1Scalar`.
 *
 * @param signature - The signature to encode.
 * @returns The `{ sigR, sigS }` little-endian scalar bytes.
 */
export function ecdsaSignatureToLeBytes(
  signature: EcdsaSignature,
): EcdsaSignatureBytes {
  return {
    sigR: bigintToBytes32(signature.r),
    sigS: bigintToBytes32(signature.s),
  };
}

/**
 * Derive the secp256k1 public key point from a private key — the MPC
 * attestation key, which is the MPC root key used directly as the secp256k1
 * private key (the same key the EVM signing accounts epsilon-derive from).
 *
 * @param secretKey - The 32-byte secp256k1 private key (the MPC root key).
 * @returns The public key as a {@link Secp256k1Point}.
 */
export function secp256k1PublicKeyFromSecretKey(
  secretKey: Uint8Array,
): Secp256k1Point {
  const point = secp256k1.Point.fromBytes(secp256k1.getPublicKey(secretKey, false));
  return { x: point.x, y: point.y, identity: false };
}

/**
 * Parse a secp256k1 public key from its 0x-hex config/env form (compressed
 * 33-byte or uncompressed 65-byte) into the runtime's point shape — how
 * deploys receive `MPC_SECP256K1_PUBKEY`.
 *
 * @param value - The 0x-hex public key (0x prefix optional).
 * @returns The parsed point.
 * @throws Error if the value is not a valid secp256k1 point encoding.
 */
export function parseSecp256k1PublicKey(value: string): Secp256k1Point {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  try {
    const point = secp256k1.Point.fromHex(hex);
    return { x: point.x, y: point.y, identity: false };
  } catch {
    throw new Error(
      `expected a secp256k1 public key as compressed/uncompressed 0x-hex; got "${value}"`,
    );
  }
}

/**
 * Format a secp256k1 public key as the compressed 0x-hex config/env form that
 * {@link parseSecp256k1PublicKey} accepts — the round-trip inverse, for
 * handing a derived key to deploys as `MPC_SECP256K1_PUBKEY`.
 *
 * @param point - The point to format.
 * @returns The compressed public key as 0x-prefixed hex.
 * @throws Error if the point is the identity (has no compressed encoding).
 */
export function formatSecp256k1PublicKey(point: Secp256k1Point): string {
  if (point.identity) {
    throw new Error("cannot format the identity point as a public key");
  }
  return `0x${secp256k1.Point.fromAffine({ x: point.x, y: point.y }).toHex(true)}`;
}

/**
 * Hash a secp256k1 point exactly as the circuits do
 * (`persistentHash<Secp256k1Point>`) — the form the signet contract and caller
 * seal as `mpcPubKeyHash`.
 *
 * @param point - The point to hash.
 * @returns The 32-byte hash.
 */
export function hashSecp256k1Point(point: Secp256k1Point): Uint8Array {
  return persistentHash(CompactTypeSecp256k1Point, point);
}
