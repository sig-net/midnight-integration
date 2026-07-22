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
 * Compiled pure circuits of Signet.compact (run `yarn compile` first): the
 * executable reference implementation of the client-agnostic circuits —
 * the attestation digest (`signetAttestationDigest`), response verification
 * (`verifyRespondBidirectionalEvent`), the deploy-time key pin
 * (`signetKeyHash`), the notification packer
 * (`constructSignBidirectionalEventNotificationV1`), and the ABI word
 * builders/reader (`evmAddressAbiWord`, `numericAbiWord`,
 * `abiWordToUint128`). Off-chain code MUST use
 * these instead of re-porting the algorithms — they are the same compiled
 * logic the contracts prove. The generic request circuits cannot be compiled
 * here (type-parameterized): request construction is contract-only, and
 * request-id hashing has a documented-deviation TS twin
 * (`calculateRequestId` in signet-requests.ts).
 */
export { pureCircuits, type PureCircuits } from "./managed/contract/index.js";
