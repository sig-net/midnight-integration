// Handwritten witnesses live beside the contract they serve. The vault's
// identity model: callerSecretKey supplies the user's secret from private
// state; only its commitment (userCommitment in the contract) ever reaches
// the ledger. claimDeposit's Schnorr verification additionally needs the
// shared Schnorr module's challenge-reduction witness (see Schnorr.compact
// and signet-contract's witnesses.ts, which this mirrors).

import type { Witnesses } from "./managed/contract/index.js";

/** Private state carried through vault circuit calls. */
export interface VaultPrivateState {
  /** The caller's 32-byte identity secret; never disclosed on-chain. */
  readonly secretKey: Uint8Array;
}

/**
 * Build the vault's private state.
 *
 * @param secretKey - The caller's 32-byte identity secret.
 * @returns A fresh private state holding `secretKey`.
 */
export const createVaultPrivateState = (
  secretKey: Uint8Array,
): VaultPrivateState => ({ secretKey });

// 2^248 — the Schnorr challenge truncation modulus (mirrors TWO_248 in
// Schnorr.compact).
const TWO_248 = 1n << 248n;

/**
 * Witness implementations, typed against the generated `Witnesses` shape.
 * `callerSecretKey` feeds the contract's identity commitment (and thereby the
 * MPC derivation path) from private state; `getSchnorrReduction` splits the
 * Poseidon challenge into (quotient, remainder) by 2^248 so claimDeposit's
 * in-circuit Schnorr verification can truncate it into Jubjub's scalar field
 * — a witness computation, not verification logic.
 */
export const witnesses: Witnesses<VaultPrivateState> = {
  callerSecretKey: ({ privateState }): [VaultPrivateState, Uint8Array] => [
    privateState,
    privateState.secretKey,
  ],
  getSchnorrReduction: (
    { privateState },
    challengeHash: bigint,
  ): [VaultPrivateState, [bigint, bigint]] => [
    privateState,
    [challengeHash / TWO_248, challengeHash % TWO_248],
  ],
};
