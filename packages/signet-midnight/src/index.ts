// Midnight-side sig-net integration: the client-agnostic signet protocol
// library (wire structs, state readers, request feed/resolver, crypto) plus
// the compiled pure circuits of the shared Compact module.

export * from "./signet-requests.ts";
export * from "./signet-evtype2tx-requests.ts";
export * from "./signature-state-reading.ts";
export * from "./signature-requests-state-reader.ts";
export * from "./signet-contract-state-reader.ts";
export * from "./signature-response-verification.ts";
export * from "./signet-request-response-reader.ts";
export * from "./signet-request-resolver.ts";
export * from "./signet-request-feed.ts";
export * from "./constants.ts";
export * from "./epsilon-derivation.ts";
export * from "./ecdsa-attestation.ts";

/**
 * Compiled pure circuits of Signet.compact (run `yarn compile` first).
 * Off-chain code MUST use these instead of re-porting the algorithms:
 * they are the same compiled logic the contracts prove.
 */
export { pureCircuits, type PureCircuits } from "./managed/contract/index.js";
