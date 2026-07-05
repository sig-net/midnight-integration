// Handwritten witnesses live beside the contract they serve. The responses
// contract's identity model: localSecretKey supplies the owner's secret from
// private state; only its commitment (ownerCommittment in the contract) ever
// reaches the ledger, and it gates postResponse.

import type { Witnesses } from "./managed/contract/index.js";

/** Private state carried through signature-responses circuit calls. */
export interface ResponsesPrivateState {
  /** The owner's 32-byte secret; never disclosed on-chain. */
  readonly secretKey: Uint8Array;
}

/**
 * Build the responses contract's private state.
 *
 * @param secretKey - The owner's 32-byte secret.
 * @returns A fresh private state holding `secretKey`.
 */
export const createResponsesPrivateState = (
  secretKey: Uint8Array,
): ResponsesPrivateState => ({ secretKey });

/**
 * Witness implementations, typed against the generated `Witnesses` shape.
 * `localSecretKey` feeds the contract's owner gate (initialise/postResponse)
 * from private state.
 */
export const witnesses: Witnesses<ResponsesPrivateState> = {
  localSecretKey: ({ privateState }): [ResponsesPrivateState, Uint8Array] => [
    privateState,
    privateState.secretKey,
  ],
};
