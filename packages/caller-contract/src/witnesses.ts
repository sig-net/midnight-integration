// Handwritten witnesses live beside the contract they serve. The caller's
// identity model (copied from the erc20-vault example): deployerSecretKey
// supplies the deployer's secret from private state; only its commitment
// (deployerCommitment in the contract) ever reaches the ledger. It gates the
// one-shot initialise circuit — submit and verify use no witnesses.

import type { Witnesses } from "./managed/signet-caller/contract/index.js";

/** Private state carried through signet-caller circuit calls. */
export interface CallerPrivateState {
  /** The deployer's 32-byte identity secret; never disclosed on-chain. */
  readonly secretKey: Uint8Array;
}

/**
 * Build the caller's private state.
 *
 * @param secretKey - The deployer's 32-byte identity secret (only initialise
 *   consumes it; any 32 bytes satisfy the other circuits).
 * @returns A fresh private state holding `secretKey`.
 */
export const createCallerPrivateState = (
  secretKey: Uint8Array,
): CallerPrivateState => ({ secretKey });

/**
 * Witness implementations, typed against the generated `Witnesses` shape.
 * `deployerSecretKey` feeds the contract's deployer commitment check from
 * private state.
 */
export const witnesses: Witnesses<CallerPrivateState> = {
  deployerSecretKey: ({ privateState }): [CallerPrivateState, Uint8Array] => [
    privateState,
    privateState.secretKey,
  ],
};
