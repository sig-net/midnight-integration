// Fakenet MPC key material helpers: root key generation and public-key
// derivation. Test-harness only (a real client never holds the MPC root key):
// these mirror what the fakenet response server derives from its MPC_ROOT_KEY
// so the e2e setup can precompute the same public keys it will present.

import { randomBytes } from "node:crypto";

import { SigningKey } from "ethers";

/**
 * The root public key the MPC network presents for a given root key: the
 * secp256k1 key its EVM signing accounts (and its per-signet-deployment
 * response key) epsilon-derive from.
 */
export interface MpcPublicKeys {
  /** Compressed secp256k1 public key as 0x-hex (`MPC_SECP256K1_PUBKEY`). */
  secp256k1CompressedPubkey: string;
}

/**
 * Derive the MPC public keys from a root key, the same way the MPC server
 * does: the root key used directly as a secp256k1 private key.
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
  const secp = new SigningKey(`0x${root}`);
  return {
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
