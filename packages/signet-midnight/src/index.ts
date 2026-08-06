// Midnight-side sig-net integration: the client-agnostic signet protocol
// library (wire structs, state readers, event decoders, request feed,
// crypto) plus the compiled pure circuits of the shared Compact module.

export * from "./abi-serde.ts";
export * from "./signet-requests.ts";
export * from "./signet-evtype2tx-requests.ts";
export * from "./signature-state-reading.ts";
export * from "./signature-requests-state-reader.ts";
export * from "./signet-contract-events.ts";
export * from "./signature-response-verification.ts";
export * from "./signet-request-response-reader.ts";
export * from "./signet-request-feed.ts";
export * from "./constants.ts";
export * from "./epsilon-derivation.ts";
// Explicit list: ecdsa-attestation.ts also backs the ./testing entry point
// (the attestation-minting helpers that take a secret key live THERE), and
// its record decoder (mpcSignatureToEcdsaSignature) is package-internal.
export {
  BLS_ORDER,
  SECP256K1_ORDER,
  bigintToBytes32,
  bigintToBytes32BE,
  bytesToBigint,
  bytesToBigintBE,
  formatSecp256k1PublicKey,
  parseSecp256k1PublicKey,
  verifyRespondBidirectionalSignature,
  type Secp256k1Point,
} from "./ecdsa-attestation.ts";

/**
 * Compiled pure circuits of Signet.compact (run `yarn compile` first).
 * Off-chain code MUST use these instead of re-porting the algorithms:
 * they are the same compiled logic the contracts prove.
 */
export { pureCircuits, type PureCircuits } from "./managed/contract/index.js";
