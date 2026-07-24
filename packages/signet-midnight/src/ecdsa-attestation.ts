// secp256k1 ECDSA helpers: the TS side of the respond-bidirectional
// attestation flow in Signet.compact: SIGNING (which needs the secret
// scalar, so it cannot be a circuit), key parsing/formatting, the
// byte-order conversions between noble's bigints and the ledger-stored
// little-endian scalar bytes, and the attestation digest's TS twin.
// Everything provable stays in Compact where possible: in-circuit
// verification is `verifyRespondBidirectionalEvent`, the deploy-time key pin
// is `pureCircuits.signetKeyHash`. The digest circuit is size-generic and the
// compiler cannot export size-generic circuits top-level, so the digest is
// the ONE sanctioned TS twin here, pinned byte-for-byte against the
// fixed-width oracle circuits circuits.compact exports (see
// tests/ecdsa-attestation.test.ts).
//
// This belongs in github.com/sig-net/signet.js as its Midnight adapter,
// kept here until upstreamed.

import { ethers } from "ethers";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { Secp256k1Point } from "@midnight-ntwrk/compact-runtime";
import type { RequestId } from "./signet-requests.ts";

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
    // The index is in range by construction; the assertion satisfies
    // consumers compiling with noUncheckedIndexedAccess.
    result = (result << 8n) | BigInt(bytes[i]!);
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

/** Convert big-endian bytes to a bigint (SEC1 coordinate order). */
function bytesToBigintBE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/**
 * An ECDSA signature over the attestation digest, in the MPC's canonical
 * `Signature { big_r, s, recovery_id }` spirit with `r` already reduced to
 * the scalar `big_r.x mod n` — the form Compact's `Secp256k1EcdsaSignature`
 * takes.
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
 * @param digest - The 32-byte digest to sign (e.g. the
 *   {@link calculateSignetAttestationDigest} output).
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

/**
 * The attestation digest of a respond-bidirectional response:
 * `keccak256(requestId || serializedOutput)`, the 32-byte digest the MPC
 * ECDSA-signs to attest a remote execution.
 *
 * TS twin of the size-generic Compact circuit
 * `calculateSignetAttestationDigest` (which the compiler cannot export
 * compiled, so this is the one sanctioned re-implementation, pinned
 * byte-for-byte against the fixed-width oracle circuits in
 * circuits.compact). The constructions agree because the circuit's keccak
 * preimage of the `[RequestId, Bytes<N>]` pair is the raw concatenated
 * bytes, and it matches the MPC's respond-bidirectional hash
 * (`hash(request_id || serialized_output)`: one flat concatenation, one
 * hash). The output is hashed AS GIVEN, at its exact length: no padding and
 * no length binding.
 *
 * @param requestId - The 32-byte request id the response answers.
 * @param serializedOutput - The serialised execution output, exact unpadded bytes.
 * @returns The 32-byte attestation digest.
 */
export function calculateSignetAttestationDigest(
  requestId: RequestId,
  serializedOutput: Uint8Array,
): Uint8Array {
  return ethers.getBytes(
    ethers.keccak256(ethers.concat([requestId, serializedOutput])),
  );
}
