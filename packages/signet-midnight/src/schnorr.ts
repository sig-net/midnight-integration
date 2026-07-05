// Jubjub Schnorr helpers — seed of the schnorr module planned in README.md.
// Ported bit by bit from the old repo's boilerplate/contract-cli/src/signet/
// schnorr.ts; only key derivation has been ported so far (sign/verify/
// challenge come across with the claim flow).
//
// This belongs in github.com/sig-net/signet.js as its Midnight adapter —
// kept here until upstreamed. The derivation is Midnight-specific (Jubjub
// embedded in BLS12-381 via @midnight-ntwrk/compact-runtime EC ops), which is
// exactly why signet.js does not cover it today.

import {
  CompactTypeBytes,
  CompactTypeVector,
  ecMulGenerator,
  persistentHash,
  type JubjubPoint,
} from "@midnight-ntwrk/compact-runtime";

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
