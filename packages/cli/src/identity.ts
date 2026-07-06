// The user's vault identity: secret key → commitment → MPC derivation path.
// Derivation calls the compiled circuits — never a TS re-implementation.

import { bytesToHex, signetPathOfCommitment } from "@midnight-erc20-vault/signet-midnight";
import { pureCircuits } from "@midnight-erc20-vault/vault-contract";

import type { CliConfig } from "./config.ts";

/** The caller identity every vault interaction is bound to. */
export interface UserIdentity {
  /** The 32-byte secret answering the vault's `callerSecretKey` witness. */
  readonly secretKey: Uint8Array;
  /** `userCommitment(secretKey)` — the only identity form that reaches the ledger. */
  readonly commitment: Uint8Array;
  /** Canonical lowercase hex of the commitment (no 0x prefix). */
  readonly commitmentHex: string;
  /** The MPC derivation path: the commitment hex, zero-padded to the path width. */
  readonly path: Uint8Array;
}

/**
 * Derive the user's vault identity from the configured secret key, using the
 * vault's compiled `userCommitment` circuit and signet-midnight's canonical
 * path construction.
 *
 * @param config - The CLI configuration holding the identity secret.
 * @returns The derived identity.
 */
export function getUserIdentity(config: CliConfig): UserIdentity {
  const commitment = pureCircuits.userCommitment(config.userSecretKey);
  return {
    secretKey: config.userSecretKey,
    commitment,
    commitmentHex: bytesToHex(commitment),
    path: signetPathOfCommitment(commitment),
  };
}
