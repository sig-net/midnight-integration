// Handwritten witnesses live beside the contract they serve. These serve the
// placeholder contract; the real vault witnesses (callerSecretKey,
// getSchnorrReduction) and VaultPrivateState replace them during the port.

import type { Witnesses } from "./managed/contract/index.js";

export type VaultPrivateState = Record<string, never>;

export const createVaultPrivateState = (): VaultPrivateState => ({});

export const witnesses: Witnesses<VaultPrivateState> = {
  placeholderSecret: ({ privateState }): [VaultPrivateState, Uint8Array] => [
    privateState,
    new Uint8Array(32),
  ],
};
