// The signet contract has no witnesses: Schnorr verification is
// CompactStandardLibrary's `jubjubSchnorrVerify` (fully in-circuit), and
// there is no private state — posting carries no caller secrets.

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

/**
 * Witness implementations, typed against the generated `Witnesses` shape:
 * the contract declares none.
 */
export const witnesses: Witnesses<SignetContractPrivateState> = {};
