// The signet signer has no witnesses: it emits posts without verifying
// them, and there is no private state, since posting carries no caller
// secrets.

import type { Witnesses } from "./managed/contract/index.js";

/** Private state carried through signet-signer circuit calls: none. */
export type SignetSignerPrivateState = Record<string, never>;

/**
 * Build the contract's (empty) private state.
 *
 * @returns A fresh, empty private state.
 */
export const createSignetSignerPrivateState = (): SignetSignerPrivateState => ({});

/**
 * Witness implementations, typed against the generated `Witnesses` shape:
 * the contract declares none.
 */
export const witnesses: Witnesses<SignetSignerPrivateState> = {};
