// Midnight-side sig-net integration. See README.md for the module plan:
// request-id, calldata-builder, tx-builder, codec, constants, schnorr,
// state-reader, response-poller — ported bit by bit from the old repo's
// boilerplate/contract-cli/src/signet/.

export * from "./signet-requests.ts";
export * from "./signature-state-reading.ts";
export * from "./signature-requests-state-reader.ts";
export * from "./signet-contract-state-reader.ts";
export * from "./signature-response-verification.ts";
export * from "./signet-request-response-reader.ts";
export * from "./constants.ts";
export * from "./epsilon-derivation.ts";
export * from "./schnorr.ts";
export * from "./mpc-keys.ts";

/**
 * Compiled pure circuits of Signet.compact (run `npm run compile` first): the
 * executable reference implementation of the client-agnostic circuits —
 * path<->identity checks, the attestation message, and the Schnorr challenge.
 * Off-chain code MUST use these instead of re-porting the algorithms — they
 * are the same compiled logic the contracts prove. The generic request
 * circuits (request-id hashing, request construction) are monomorphized in
 * each requester package instead (e.g. vault-contract's vaultSignetCircuits).
 */
export { pureCircuits, type PureCircuits } from "./managed/contract/index.js";
