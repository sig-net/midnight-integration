// Midnight-side sig-net integration: the client-agnostic signet protocol
// library (wire structs, state readers, event decoders, request feed,
// crypto) plus the compiled pure circuits of the shared Compact module.

export * from "./abi-serde.ts";
export {
  bigintToBytes32,
  bigintToBytes32BE,
  BLS_ORDER,
  bytesToBigint,
  bytesToBigintBE,
  bytesToHex,
  hexToBytes,
  stripHexPrefix,
} from "./byte-codecs.ts";
// Explicit lists for the request/state modules: the runtime descriptor
// toolkit (compact-descriptors.ts and the per-module record descriptors) is
// package-internal, consumed only through the reader and request functions.
export * from "./constants.ts";
// Selective: deriveMidnightResponseSecretKey takes the MPC root secret, so
// it is exported through ./testing with the other secret-taking helpers.
export {
  deriveEpsilon,
  deriveEvmAddress,
  deriveMidnightResponseKey,
  EPSILON_DERIVATION_PREFIX,
  MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH,
  MIDNIGHT_TESTNET_CHAIN_ID,
} from "./epsilon-derivation.ts";
export { type RawContractState, signetFieldNodeByPath } from "./raw-contract-state.ts";
export * from "./signature-requests-state-reader.ts";
export * from "./signature-response-verification.ts";
export * from "./signet-contract-events.ts";
export {
  abiWordToBool,
  abiWordToUint128,
  assembleCalldata,
  boolAbiWord,
  type EvmAccessListEntry,
  evmAddressAbiWord,
  type EvmCalldata,
  type EvmType2TxParams,
  numericAbiWord,
  signBidirectionalEventToSignedEvmTransaction,
  signBidirectionalEventToUnsignedEvmTransaction,
} from "./signet-evtype2tx-requests.ts";
export { calculateRequestId } from "./signet-request-id.ts";
export * from "./signet-request-response-reader.ts";
export {
  type ContractAddress,
  contractAddressFromHex,
  type Maybe,
  MPCDestination,
  MPCSignatureAlgorithm,
  parseRequestIdHex,
  PATH_BYTES,
  type RequestId,
  requestIdBytes,
  type RequestIdHex,
  requestIdHex,
  type SignBidirectionalEvent,
  type SignBidirectionalEventIndex,
  type SignBidirectionalEventLedgerMap,
  toSignBidirectionalEventIndex,
  TxParamType,
} from "./signet-requests.ts";
// Explicit list: ecdsa-attestation.ts also backs the ./testing entry point
// (the attestation-minting helpers that take a secret key live THERE), and
// its record decoder (mpcSignatureToEcdsaSignature) is package-internal.
export {
  formatSecp256k1PublicKey,
  parseSecp256k1PublicKey,
  respondBidirectionalEventToCircuitInput,
  SECP256K1_ORDER,
  type Secp256k1Point,
  signatureRespondedEventToSignature,
  verifyRespondBidirectionalSignature,
} from "./ecdsa-attestation.ts";

/**
 * Compiled pure circuits of Signet.compact (run `yarn compile` first).
 * Off-chain code MUST use these instead of re-porting the algorithms:
 * they are the same compiled logic the contracts prove.
 */
export { type PureCircuits, pureCircuits } from "./managed/contract/index.js";
