// The signet responder has no witnesses: it emits posts without verifying
// them, and posting carries no caller secrets, so there is no private state.

import type { Witnesses } from "./managed/contract/index.js";

/** Private state carried through signet-responder circuit calls: none. */
export type SignetResponderPrivateState = Record<string, never>;

/**
 * Build the contract's (empty) private state.
 *
 * @returns A fresh, empty private state.
 */
export const createSignetResponderPrivateState = (): SignetResponderPrivateState => ({});

/**
 * Witness implementations, typed against the generated `Witnesses` shape:
 * the contract declares none.
 */
export const witnesses: Witnesses<SignetResponderPrivateState> = {};
