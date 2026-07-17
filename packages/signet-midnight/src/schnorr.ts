// Jubjub Schnorr helpers — the TS side of the shared Schnorr.compact module:
// key derivation, SIGNING (which needs the secret scalar, so it cannot be a
// circuit), and key parsing/hashing. Everything provable stays in Compact:
// the challenge is the COMPILED `pureCircuits.schnorrChallenge`, injected by
// callers (see SchnorrChallengeFn), and the attestation message is the
// compiled `pureCircuits.signetAttestationMessage` — this file never
// re-implements either. Verification lives in circuits only
// (CompactStandardLibrary's jubjubSchnorrVerify, run by the signet contract
// at post time).
//
// This belongs in github.com/sig-net/signet.js as its Midnight adapter —
// kept here until upstreamed. The math is Midnight-specific (Jubjub embedded
// in BLS12-381 via @midnight-ntwrk/compact-runtime EC ops), which is exactly
// why signet.js does not cover it today.

import { randomBytes } from "node:crypto";

import {
  CompactTypeBytes,
  CompactTypeJubjubPoint,
  CompactTypeVector,
  ecMulGenerator,
  persistentHash,
  type JubjubPoint,
} from "@midnight-ntwrk/compact-runtime";

// Re-exported because it appears throughout this module's public signatures
// (hashJubjubPoint, parse/formatJubjubPublicKey, JubjubKeypair.pk) — SDK
// consumers shouldn't have to depend on compact-runtime just for the type.
export type { JubjubPoint } from "@midnight-ntwrk/compact-runtime";

/** Jubjub curve scalar field order (group order of the generator). */
export const JUBJUB_ORDER = 6554484396890773809930967563523245729705921265872317281365359162392183254199n;

/** BLS12-381 scalar field order (the Compact `Field` type modulus). */
export const BLS_ORDER = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;

const bytes32Type = new CompactTypeBytes(32);
const vec2x32Type = new CompactTypeVector(2, bytes32Type);

/**
 * Convert little-endian bytes to a bigint. Matches Compact's
 * `Bytes<32> as Field` interpretation (and the MPC monitor's ABI-word
 * decoding convention).
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
 * `Field as Bytes<32>` encoding (the inverse of {@link bytesToBigint});
 * negative inputs are interpreted in the BLS scalar field.
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

/** A Jubjub keypair: the secret scalar and its public curve point. */
export interface JubjubKeypair {
  /** Secret scalar in `[1, JUBJUB_ORDER - 1]`. */
  sk: bigint;
  /** Public key: `sk * G` on Jubjub. */
  pk: JubjubPoint;
}

/** Zero-pad an ASCII domain tag to 32 bytes (Compact `pad(32, ...)`). */
function pad32(tag: string): Uint8Array {
  const padded = new Uint8Array(32);
  new TextEncoder().encodeInto(tag, padded);
  return padded;
}

/**
 * Derive a Jubjub keypair from a seed — the same derivation the MPC server
 * performs on its root key, so this MUST stay bit-identical to it:
 * `sk = (persistentHash([pad32("jubjub:auth:"), seed]) mod (order - 1)) + 1`,
 * `pk = sk * G`.
 *
 * @param seed - Seed bytes (e.g. the 32-byte MPC root key).
 * @returns The derived {@link JubjubKeypair}.
 */
export function deriveJubjubKeypair(seed: Uint8Array): JubjubKeypair {
  const skBytes = persistentHash(vec2x32Type, [pad32("jubjub:auth:"), seed]);
  const sk = (bytesToBigint(skBytes) % (JUBJUB_ORDER - 1n)) + 1n;
  const pk = ecMulGenerator(sk);
  return { sk, pk };
}

// ---- Schnorr signing ----

/**
 * A Schnorr signature (TS twin of CompactStandardLibrary's
 * `JubjubSchnorrSignature`).
 */
export interface SchnorrSignature {
  /** Nonce commitment R = k * G. */
  announcement: JubjubPoint;
  /** Signature scalar s = (k + c * sk) mod JUBJUB_ORDER. */
  response: bigint;
}

/**
 * Computes the Schnorr challenge (the Poseidon transientHash output reduced
 * into Jubjub's scalar field, exactly as `jubjubSchnorrVerify` computes it).
 * ALWAYS inject the compiled circuit — signet-midnight's own
 * `pureCircuits.schnorrChallenge` — never a TS re-implementation; keeping it
 * injected keeps this signer decoupled from any one compiled artifact.
 */
export type SchnorrChallengeFn = (
  annX: bigint,
  annY: bigint,
  pkX: bigint,
  pkY: bigint,
  msg: bigint[],
) => bigint;

/**
 * Sign a message with Schnorr on Jubjub, matching CompactStandardLibrary's
 * `jubjubSchnorrVerify`: `c = challenge` (already reduced into Jubjub's
 * scalar field by the compiled circuit), `s = (k + c * sk) mod JUBJUB_ORDER`.
 * For signet attestations the message is the compiled
 * `pureCircuits.signetAttestationMessage(requestId, outputData)`.
 *
 * @param sk - Jubjub private key scalar.
 * @param msg - Message field limbs.
 * @param schnorrChallenge - The compiled `pureCircuits.schnorrChallenge`.
 * @returns The signature (announcement R, response s).
 * @throws Error if `sk` reduces to zero mod the Jubjub order.
 */
export function schnorrSign(
  sk: bigint,
  msg: bigint[],
  schnorrChallenge: SchnorrChallengeFn,
): SchnorrSignature {
  const skReduced = ((sk % JUBJUB_ORDER) + JUBJUB_ORDER) % JUBJUB_ORDER;
  if (skReduced === 0n) {
    throw new Error("Private key must be non-zero mod JUBJUB_ORDER");
  }

  const pk = ecMulGenerator(skReduced);
  const k = (bytesToBigint(randomBytes(32)) % JUBJUB_ORDER) || 1n;
  const announcement = ecMulGenerator(k);

  // schnorrChallenge returns the challenge already reduced into Jubjub's
  // scalar field — use it as-is.
  const c = schnorrChallenge(announcement.x, announcement.y, pk.x, pk.y, msg);

  const response = (((k + c * skReduced) % JUBJUB_ORDER) + JUBJUB_ORDER) % JUBJUB_ORDER;
  return { announcement, response };
}

/**
 * Hash a Jubjub point exactly as the circuits do (`persistentHash<JubjubPoint>`)
 * — the form the signet contract seals as `mpcPubKeyHash`.
 *
 * @param point - The point to hash.
 * @returns The 32-byte hash.
 */
export function hashJubjubPoint(point: JubjubPoint): Uint8Array {
  return persistentHash(CompactTypeJubjubPoint, point);
}

/**
 * Parse a Jubjub public key from its `"x,y"` config/env form (decimal or
 * 0x-hex field coordinates) — how deploys receive `MPC_JUBJUB_PK`.
 *
 * @param value - The `"x,y"` string.
 * @returns The parsed point.
 * @throws Error if the value is not two comma-separated field coordinates.
 */
export function parseJubjubPublicKey(value: string): JubjubPoint {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length !== 2 || parts.some((part) => part === "")) {
    throw new Error(`expected a Jubjub public key as "x,y"; got "${value}"`);
  }
  try {
    return { x: BigInt(parts[0]), y: BigInt(parts[1]) };
  } catch {
    throw new Error(`Jubjub public key coordinates must be decimal or 0x-hex integers; got "${value}"`);
  }
}

/**
 * Format a Jubjub public key as the `"x,y"` decimal config/env form that
 * {@link parseJubjubPublicKey} accepts — the round-trip inverse, for handing
 * a derived key to deploys as `MPC_JUBJUB_PK`.
 *
 * @param point - The point to format.
 * @returns The `"x,y"` string with decimal coordinates.
 */
export function formatJubjubPublicKey(point: JubjubPoint): string {
  return `${point.x},${point.y}`;
}
