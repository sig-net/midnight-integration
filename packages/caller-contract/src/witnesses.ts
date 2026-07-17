// The signet caller has no witnesses: both circuits work entirely on public
// state and circuit arguments — the request is contract-composed, and the
// response verification is CompactStandardLibrary's `jubjubSchnorrVerify`
// (fully in-circuit). There is no private state.

import type { Witnesses } from "./managed/signet-caller/contract/index.js";

/** Private state carried through signet-caller circuit calls: none. */
export type CallerPrivateState = Record<string, never>;

/**
 * Build the contract's (empty) private state.
 *
 * @returns A fresh, empty private state.
 */
export const createCallerPrivateState = (): CallerPrivateState => ({});

/**
 * Witness implementations, typed against the generated `Witnesses` shape:
 * the contract declares none.
 */
export const witnesses: Witnesses<CallerPrivateState> = {};
