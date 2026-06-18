/**
 * Schnorr Signature on Jubjub Curve
 *
 * Implements Schnorr signing and verification using the Jubjub curve
 * embedded in BLS12-381, via Midnight's compact-runtime EC operations.
 *
 * Matches the shared `schnorr` Compact module (Midnight zkloan polyfill):
 *   Sign(sk, msg):
 *     pk = sk * G;  k = random;  R = k * G
 *     cFull = transientHash(R.x, R.y, pk.x, pk.y, msg)   (Poseidon, via schnorrChallenge)
 *     c = cFull mod 2^248                                (truncation; circuit does the same)
 *     s = (k + c * sk) mod JUBJUB_ORDER
 *     Return (announcement = R, response = s)
 *
 *   Verify(pk, msg, R, s):  s * G == R + c * pk
 *
 * The challenge is Poseidon (transientHash), so the caller injects the
 * contract's `pureCircuits.schnorrChallenge` to compute it identically.
 */

import { randomBytes } from 'node:crypto';
import {
  ecMulGenerator,
  ecMul,
  ecAdd,
  persistentHash,
  CompactTypeJubjubPoint,
  CompactTypeBytes,
  CompactTypeVector,
} from '@midnight-ntwrk/compact-runtime';
import type { JubjubPoint } from '@midnight-ntwrk/compact-runtime';

// ---- Constants ----

/** Jubjub curve scalar field order (group order of the generator). */
export const JUBJUB_ORDER = 6554484396890773809930967563523245729705921265872317281365359162392183254199n;

/** BLS12-381 scalar field order (the Field type modulus). */
export const BLS_ORDER = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;

// ---- Type helpers ----

const bytes32Type = new CompactTypeBytes(32);
const bytes4096Type = new CompactTypeBytes(4096);
const vec2x32Type = new CompactTypeVector(2, bytes32Type);

// ---- Scalar/bytes conversion ----

/**
 * Convert a bigint to exactly 32 bytes (little-endian).
 * Matches Compact's `Field as Bytes<32>` encoding.
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
 * Convert a Uint8Array (little-endian) to a bigint.
 * Matches Compact's `Bytes<32> as Field` interpretation.
 */
export function bytesToBigint(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

// ---- Schnorr signature ----

/** 2^248 — challenge truncation modulus (matches the `schnorr` module). */
const TWO_248 = 452312848583266388373324160190187140051835877600158453279131187530910662656n;

/** Result of a Schnorr signature (matches the `schnorr` module's SchnorrSignature). */
export interface SchnorrSignature {
  /** Nonce commitment R = k * G. */
  announcement: JubjubPoint;
  /** Signature scalar s = (k + c * sk) mod JUBJUB_ORDER. */
  response: bigint;
}

/**
 * Computes the Schnorr challenge (full Poseidon transientHash output). Injected
 * by the caller — typically a contract's `pureCircuits.schnorrChallenge`, which
 * embeds the shared `schnorr` module. Keeping it injected keeps this signer
 * contract-agnostic (one implementation serves every signet contract).
 */
export type SchnorrChallengeFn = (
  annX: bigint, annY: bigint, pkX: bigint, pkY: bigint, msg: bigint[],
) => bigint;

/** Read 16 bytes little-endian as a bigint (matches Compact's `Bytes<16> as Field`). */
function leLimb16(bytes: Uint8Array, offset: number): bigint {
  let r = 0n;
  for (let i = 15; i >= 0; i--) r = (r << 8n) | BigInt(bytes[offset + i]);
  return r;
}

/**
 * Build the signet response message: (requestId, hash(outputData)) encoded as
 * four 16-byte little-endian field limbs — exactly what the circuit hashes.
 */
export function buildSignetMessage(requestId: Uint8Array, outputData: Uint8Array): bigint[] {
  const outHash = persistentHash(bytes4096Type, outputData);
  return [
    leLimb16(requestId, 0), leLimb16(requestId, 16),
    leLimb16(outHash, 0), leLimb16(outHash, 16),
  ];
}

/**
 * Sign a signet message with Schnorr on Jubjub, matching the shared `schnorr`
 * Compact module. Returns (announcement R, response s); the circuit's witness
 * derives the challenge reduction, so no (h, quotient) are sent.
 *
 * @param sk - Jubjub private key scalar
 * @param msg - message field limbs (see buildSignetMessage)
 * @param schnorrChallenge - the contract's pureCircuits.schnorrChallenge
 */
export function schnorrSign(
  sk: bigint,
  msg: bigint[],
  schnorrChallenge: SchnorrChallengeFn,
): SchnorrSignature {
  sk = ((sk % JUBJUB_ORDER) + JUBJUB_ORDER) % JUBJUB_ORDER;
  if (sk === 0n) throw new Error('Private key must be non-zero mod JUBJUB_ORDER');

  const pk = ecMulGenerator(sk);
  const k = (bytesToBigint(randomBytes(32)) % JUBJUB_ORDER) || 1n;
  const R = ecMulGenerator(k);

  // schnorrChallenge returns the full Poseidon hash; truncate to 248 bits
  // (mod 2^248) to match the circuit's witness-assisted reduction.
  const cFull = schnorrChallenge(R.x, R.y, pk.x, pk.y, msg);
  const c = cFull % TWO_248;

  const s = ((k + c * sk) % JUBJUB_ORDER + JUBJUB_ORDER) % JUBJUB_ORDER;
  return { announcement: R, response: s };
}

/**
 * Verify a Schnorr signature — mirrors the circuit's `schnorrVerify`.
 * @returns true if the signature is valid
 */
export function schnorrVerify(
  pk: JubjubPoint,
  msg: bigint[],
  sig: SchnorrSignature,
  schnorrChallenge: SchnorrChallengeFn,
): boolean {
  const cFull = schnorrChallenge(sig.announcement.x, sig.announcement.y, pk.x, pk.y, msg);
  const c = cFull % TWO_248;
  const lhs = ecMulGenerator(sig.response);
  const rhs = ecAdd(sig.announcement, ecMul(pk, c));
  return lhs.x === rhs.x && lhs.y === rhs.y;
}

/**
 * Derive a Jubjub keypair from a seed.
 *
 * @param seed - Seed bytes (e.g., 32-byte secret)
 * @returns Object with sk (scalar) and pk (JubjubPoint)
 */
export function deriveJubjubKeypair(seed: Uint8Array): { sk: bigint; pk: JubjubPoint } {
  // Hash the seed to derive a scalar
  const skBytes = persistentHash(vec2x32Type, [
    new TextEncoder().encode('jubjub:auth:').reduce((arr, b, i) => { arr[i] = b; return arr; }, new Uint8Array(32)),
    seed,
  ]);
  // Reduce modulo JUBJUB_ORDER, ensure non-zero
  const sk = (bytesToBigint(skBytes) % (JUBJUB_ORDER - 1n)) + 1n;
  const pk = ecMulGenerator(sk);
  return { sk, pk };
}

/**
 * Compute the hash of a JubjubPoint (for storing as mpcPubKeyHash).
 * Matches the circuit's persistentHash<JubjubPoint>(pk).
 */
export function hashJubjubPoint(point: JubjubPoint): Uint8Array {
  return persistentHash(CompactTypeJubjubPoint, point);
}
