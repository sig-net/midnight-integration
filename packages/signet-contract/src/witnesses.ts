// The signet contract's single witness: the Schnorr challenge reduction
// required by the shared Schnorr module (see Schnorr.compact). The circuit
// cannot divide in the prime field, so the PROVING party supplies
// (quotient, remainder) of challengeHash / 2^248 and the circuit asserts
// q * 2^248 + r == challengeHash — a witness computation, not verification
// logic. There is no private state: posting carries no caller secrets.

import type { Witnesses } from "./managed/contract/index.js";

/** Private state carried through signet-contract circuit calls: none. */
export type SignetContractPrivateState = Record<string, never>;

/**
 * Build the contract's (empty) private state.
 *
 * @returns A fresh, empty private state.
 */
export const createSignetContractPrivateState =
  (): SignetContractPrivateState => ({});

// 2^248 — the Schnorr challenge truncation modulus (mirrors TWO_248 in
// Schnorr.compact).
const TWO_248 = 1n << 248n;

/**
 * Witness implementations, typed against the generated `Witnesses` shape.
 * `getSchnorrReduction` splits the Poseidon challenge into
 * (quotient, remainder) by 2^248 so the circuit can truncate it into
 * Jubjub's scalar field.
 */
export const witnesses: Witnesses<SignetContractPrivateState> = {
  getSchnorrReduction: (
    { privateState },
    challengeHash: bigint,
  ): [SignetContractPrivateState, [bigint, bigint]] => [
    privateState,
    [challengeHash / TWO_248, challengeHash % TWO_248],
  ],
};
