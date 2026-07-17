// Fakenet MPC key material helpers: root key generation and public-key
// derivation. Test-harness only — a real client never holds the MPC root key;
// these mirror what the fakenet response server derives from its MPC_ROOT_KEY
// so the e2e setup can precompute the same public keys it will present.

import { randomBytes } from "node:crypto";

import { SigningKey } from "ethers";

import { deriveJubjubKeypair, type JubjubPoint } from "@sig-net/midnight";

/**
 * The public keys the MPC network presents for a given root key: the Jubjub
 * key it Schnorr-signs responses with, and the secp256k1 key its EVM signing
 * accounts derive from.
 */
export interface MpcPublicKeys {
  /** Jubjub Point, the PK for Jubjub verification */
  jubjubPoint: JubjubPoint;
  /** Compressed secp256k1 public key as 0x-hex (`MPC_SECP256K1_PUBKEY`). */
  secp256k1CompressedPubkey: string;
}

/**
 * Derive the MPC public keys from a root key — the same calls the MPC server
 * makes: {@link deriveJubjubKeypair} for the Schnorr response key, and the
 * root key used directly as a secp256k1 private key for EVM signing.
 *
 * @param rootKeyHex - The 32-byte MPC root key as hex (0x prefix optional).
 * @returns The derived {@link MpcPublicKeys}.
 * @throws If `rootKeyHex` is not exactly 32 bytes of hex.
 */
export function deriveMpcKeys(rootKeyHex: string): MpcPublicKeys {
  const root = rootKeyHex.startsWith("0x") ? rootKeyHex.slice(2) : rootKeyHex;
  if (!/^[0-9a-fA-F]{64}$/.test(root)) {
    throw new Error("MPC root key must be 32 bytes of hex (64 hex chars, 0x prefix optional)");
  }
  const rootBytes = Uint8Array.from(Buffer.from(root, "hex"));
  const { pk } = deriveJubjubKeypair(rootBytes);
  const secp = new SigningKey(`0x${root}`);
  return {
    jubjubPoint: pk,
    secp256k1CompressedPubkey: secp.compressedPublicKey,
  };
}

/**
 * Generate a fresh random 32-byte MPC root key (the programmatic equivalent
 * of the runbook's `openssl rand -hex 32`).
 *
 * @returns The root key as lowercase 0x-prefixed hex.
 */
export function generateMpcRootKey(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}
