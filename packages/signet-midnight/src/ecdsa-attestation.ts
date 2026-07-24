// secp256k1 ECDSA helpers: the TS side of the respond-bidirectional
// attestation flow in Signet.compact — SIGNING (which needs the secret
// scalar, so it cannot be a circuit), key parsing/formatting, and the
// byte-order conversions between noble's bigints and the little-endian
// scalar bytes Compact's casts read. Everything provable stays in Compact: the
// attestation digest is the COMPILED `pureCircuits.signetAttestationDigest`,
// verification is `pureCircuits.verifyRespondBidirectionalEvent` (the same
// check client contracts run in-circuit), and the deploy-time key pin is
// `pureCircuits.signetKeyHash` — this file never re-implements any of them.
//
// This belongs in github.com/sig-net/signet.js as its Midnight adapter —
// kept here until upstreamed.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { Secp256k1Point } from "@midnight-ntwrk/compact-runtime";

import type { MpcSignature } from "./signet-contract-state-reader.ts";

// Re-exported because it appears throughout this module's public signatures —
// SDK consumers shouldn't have to depend on compact-runtime just for the type.
export type { Secp256k1Point } from "@midnight-ntwrk/compact-runtime";

/** secp256k1 curve (group) order n. */
export const SECP256K1_ORDER = secp256k1.Point.Fn.ORDER;

/** BLS12-381 scalar field order (the Compact `Field` type modulus). */
export const BLS_ORDER = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;

/**
 * Convert little-endian bytes to a bigint. Matches Compact's
 * `Bytes<32> as Field` / `Bytes<32> as Secp256k1Scalar` interpretation (both
 * casts are little-endian).
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
 * of {@link bytesToBigint}); negative inputs are interpreted in the BLS
 * scalar field.
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
 * Convert big-endian bytes to a bigint (SEC1 coordinate order, the byte
 * order the respond events' stored signature uses).
 *
 * @param bytes - Big-endian byte array.
 * @returns The decoded non-negative integer.
 */
export function bytesToBigintBE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/**
 * Convert a bigint to exactly 32 BIG-endian bytes (SEC1 scalar/coordinate
 * order, also the ABI word encoding) — the big-endian counterpart of
 * {@link bigintToBytes32} and the inverse of {@link bytesToBigintBE}.
 *
 * @param value - The non-negative integer to encode.
 * @returns The 32-byte big-endian encoding.
 * @throws Error if the value is negative or does not fit 32 bytes.
 */
export function bigintToBytes32BE(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) {
    throw new Error(`value does not fit 32 big-endian bytes: ${value}`);
  }
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * An ECDSA signature over the attestation digest, in the MPC's canonical
 * `Signature { big_r, s, recovery_id }` spirit with `r` already reduced to
 * the scalar `big_r.x mod n` — the form Compact's `Secp256k1EcdsaSignature`
 * takes. Build the stored form for posting in a respond event with
 * {@link ecdsaSignatureToMpcSignature}.
 */
export interface EcdsaSignature {
  /** Signature scalar r (= R.x mod n). */
  r: bigint;
  /** Signature scalar s (low-s normalised by the signer). */
  s: bigint;
  /** Recovery id (parity of R.y): 0 or 1. */
  recoveryId: number;
}

/**
 * ECDSA-sign a 32-byte digest with a secp256k1 secret key, exactly as the
 * MPC signs the attestation digest: RFC 6979 deterministic, low-s, the digest
 * interpreted big-endian with NO extra hashing (`prehash: false`) — the same
 * convention `secp256k1EcdsaVerify` checks in-circuit.
 *
 * @param digest - The 32-byte digest to sign (e.g. the compiled
 *   `pureCircuits.signetAttestationDigest` output).
 * @param secretKey - The 32-byte secp256k1 secret key.
 * @returns The signature with its recovery id.
 */
export function signAttestationDigest(
  digest: Uint8Array,
  secretKey: Uint8Array,
): EcdsaSignature {
  const sigBytes = secp256k1.sign(digest, secretKey, { prehash: false });
  const sig = secp256k1.Signature.fromBytes(sigBytes, "compact");
  // Recover the id by trying both parities against the actual public key.
  const pk = secp256k1.getPublicKey(secretKey, false);
  const pkHex = Buffer.from(pk).toString("hex");
  for (const recoveryId of [0, 1]) {
    const recovered = sig
      .addRecoveryBit(recoveryId)
      .recoverPublicKey(digest)
      .toHex(false);
    if (recovered === pkHex) {
      return { r: sig.r, s: sig.s, recoveryId };
    }
  }
  /* v8 ignore next: unreachable for a signature this function just produced */
  throw new Error("signature does not recover to its own public key");
}

/**
 * Build the stored-form signature both respond events carry from a
 * scalar-form one: R is reconstructed by decompressing the curve point with
 * x = `r` and the parity `recoveryId` names — undoing the compression an
 * `r || s || v` signature performs. For MPC-side posters (the fakenet
 * signer, tests). The negligible caveat: an R.x that overflowed the curve
 * order cannot be told apart from its reduced twin, so reconstruction picks
 * the x equal to `r` itself.
 *
 * @param signature - The scalar-form signature (the signer's output shape).
 * @returns The stored-form signature: R as a full point, big-endian bytes.
 * @throws Error if the recovery id is not 0 or 1, or `r` is not the x
 *   coordinate of a secp256k1 point.
 */
export function ecdsaSignatureToMpcSignature(signature: EcdsaSignature): MpcSignature {
  if (signature.recoveryId !== 0 && signature.recoveryId !== 1) {
    throw new Error(`expected a recovery id of 0 or 1, got ${signature.recoveryId}`);
  }
  // SEC1 compressed form: parity prefix (02 even, 03 odd) || x big-endian.
  const parityPrefix = signature.recoveryId === 0 ? "02" : "03";
  const xHex = signature.r.toString(16).padStart(64, "0");
  let point;
  try {
    point = secp256k1.Point.fromHex(`${parityPrefix}${xHex}`);
  } catch (error) {
    throw new Error(`signature r is not the x coordinate of a secp256k1 point (${String(error)})`);
  }
  const uncompressed = point.toBytes(false); // 0x04 || x || y
  return {
    bigR: { x: uncompressed.slice(1, 33), y: uncompressed.slice(33, 65) },
    s: bigintToBytes32BE(signature.s),
    recoveryId: BigInt(signature.recoveryId),
  };
}

/**
 * Read a stored-form signature back into scalar form — the inverse of
 * {@link ecdsaSignatureToMpcSignature}, and the read side every consumer
 * runs off-chain. `r` comes out as `bigR.x` reduced mod the curve order, the
 * scalar in-circuit verification takes: re-encode it (and `s`) little-endian
 * with {@link bigintToBytes32} for circuit arguments. Rejects records that
 * do not even hold the shape — posts are unauthenticated, so a malformed
 * record is garbage, not a signature. `bigR.y` is NOT checked against the
 * curve or the recovery id: signature verification is the authority, not
 * this decoder.
 *
 * @param signature - The stored-form signature as posted.
 * @returns The scalar-form signature.
 * @throws Error if a component has the wrong byte length or the recovery id
 *   is not 0 or 1.
 */
export function mpcSignatureToEcdsaSignature(signature: MpcSignature): EcdsaSignature {
  const { bigR, s, recoveryId } = signature;
  if (bigR.x.length !== 32 || bigR.y.length !== 32 || s.length !== 32) {
    throw new Error("expected 32-byte bigR.x/bigR.y/s in a stored signature");
  }
  if (recoveryId !== 0n && recoveryId !== 1n) {
    throw new Error(`expected a recovery id of 0 or 1, got ${recoveryId}`);
  }
  return {
    r: bytesToBigintBE(bigR.x) % SECP256K1_ORDER,
    s: bytesToBigintBE(s),
    recoveryId: Number(recoveryId),
  };
}

/**
 * Parse a secp256k1 public key from SEC1 hex (compressed or uncompressed,
 * optional `0x` prefix) into the Compact runtime's `Secp256k1Point` shape —
 * how deploys receive the MPC response key to pin.
 *
 * @param value - The SEC1 hex public key.
 * @returns The parsed point.
 * @throws Error if the value is not a valid secp256k1 public key.
 */
export function parseSecp256k1PublicKey(value: string): Secp256k1Point {
  const hex = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  let point;
  try {
    point = secp256k1.Point.fromHex(hex);
  } catch (error) {
    throw new Error(`not a secp256k1 public key in SEC1 hex: "${value}" (${String(error)})`);
  }
  const uncompressed = point.toBytes(false); // 0x04 || x || y
  return {
    x: bytesToBigintBE(uncompressed.slice(1, 33)),
    y: bytesToBigintBE(uncompressed.slice(33, 65)),
    identity: false,
  };
}

/**
 * Format a secp256k1 public key point as uncompressed SEC1 hex (with `0x`
 * prefix) — the round-trip inverse of {@link parseSecp256k1PublicKey}, for
 * handing a response key to deploys via env/config.
 *
 * @param point - The point to format.
 * @returns The `0x04…` uncompressed SEC1 hex string.
 */
export function formatSecp256k1PublicKey(point: Secp256k1Point): string {
  const toBE32 = (v: bigint): string => v.toString(16).padStart(64, "0");
  return `0x04${toBE32(point.x)}${toBE32(point.y)}`;
}

/**
 * Derive the `Secp256k1Point` of a secret key — convenience for tests and
 * signers that hold key material as raw bytes.
 *
 * @param secretKey - The 32-byte secp256k1 secret key.
 * @returns The public key point.
 */
export function secp256k1PublicKeyOf(secretKey: Uint8Array): Secp256k1Point {
  const uncompressed = secp256k1.getPublicKey(secretKey, false);
  return {
    x: bytesToBigintBE(uncompressed.slice(1, 33)),
    y: bytesToBigintBE(uncompressed.slice(33, 65)),
    identity: false,
  };
}
