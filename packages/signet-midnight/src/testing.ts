// Test-fixture surface of @sig-net/midnight (the `@sig-net/midnight/testing`
// entry point): mint a REAL respond-bidirectional attestation with a
// throwaway secret key, so a claim circuit can be unit tested in-process
// against the same record shape the MPC posts. Runtime integrations verify
// posts (root entry: `verifyRespondBidirectionalSignature`,
// `SignetRequestResponseReader`) and never sign. The fakenet responder, the
// MPC's test double, posts through these same helpers, which keeps its bytes
// pinned to this package's decoders.
//
// The canonical fixture chain:
//   ecdsaSignatureToMpcSignature(
//     signAttestationDigest(
//       calculateSignetAttestationDigest(requestId, serializedOutput),
//       secretKey,
//     ),
//   )
// verifies in-circuit against secp256k1PublicKeyOf(secretKey).

export {
  calculateSignetAttestationDigest,
  type EcdsaSignature,
  ecdsaSignatureToMpcSignature,
  secp256k1PublicKeyOf,
  signAttestationDigest,
} from "./ecdsa-attestation.ts";
export { signatureToSignatureRespondedEvent } from "./signet-evtype2tx-requests.ts";
