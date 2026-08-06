// Midnight-side sig-net integration: the client-agnostic signet protocol
// library (wire structs, state readers, event decoders, request feed,
// crypto) plus the compiled pure circuits of the shared Compact module.

export * from "./abi-serde.ts";
export * from "./constants.ts";
export * from "./ecdsa-attestation.ts";
export * from "./epsilon-derivation.ts";
export * from "./signature-requests-state-reader.ts";
export * from "./signature-response-verification.ts";
export * from "./signature-state-reading.ts";
export * from "./signet-contract-events.ts";
export * from "./signet-evtype2tx-requests.ts";
export * from "./signet-request-feed.ts";
export * from "./signet-request-response-reader.ts";
export * from "./signet-requests.ts";

/**
 * Compiled pure circuits of Signet.compact (run `yarn compile` first).
 * Off-chain code MUST use these instead of re-porting the algorithms:
 * they are the same compiled logic the contracts prove.
 */
export { type PureCircuits, pureCircuits } from "./managed/contract/index.js";
