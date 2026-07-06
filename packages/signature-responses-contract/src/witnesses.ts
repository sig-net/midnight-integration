// The signature-responses contract declares NO witnesses: posting is
// unauthenticated by design (the MPC cannot yet produce Midnight proofs), so
// circuits carry no private state and prove nothing about the caller.

import type { Witnesses } from "./managed/contract/index.js";

/** Private state carried through signature-responses circuit calls: none. */
export type SignatureResponsesPrivateState = Record<string, never>;

/**
 * Build the contract's (empty) private state.
 *
 * @returns A fresh, empty private state.
 */
export const createSignatureResponsesPrivateState =
  (): SignatureResponsesPrivateState => ({});

/**
 * Witness implementations, typed against the generated `Witnesses` shape —
 * which is empty: see the header note on why this contract has no witnesses.
 */
export const witnesses: Witnesses<SignatureResponsesPrivateState> = {};
