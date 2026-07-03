// Handwritten witnesses live beside the contract they serve. These serve the
// placeholder contract; the real witness (localSecretKey — the owner proof)
// and its private state replace them during the port.

import type { Witnesses } from "./managed/contract/index.js";

export type ResponsesPrivateState = Record<string, never>;

export const createResponsesPrivateState = (): ResponsesPrivateState => ({});

export const witnesses: Witnesses<ResponsesPrivateState> = {
  placeholderSecret: ({ privateState }): [ResponsesPrivateState, Uint8Array] => [
    privateState,
    new Uint8Array(32),
  ],
};
