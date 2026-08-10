// Client-side verification of MPC signature responses. The signet contract
// emits signature responses UNAUTHENTICATED (see the module header in
// Signet.compact), so a poller must verify every posted response before
// trusting it.

import { getAddress, recoverAddress } from "ethers";

import { signatureRespondedEventToSignature } from "./ecdsa-attestation.ts";
import type { SignatureRespondedEvent } from "./signet-contract-events.ts";
import { signBidirectionalEventToUnsignedEvmTransaction } from "./signet-evtype2tx-requests.ts";
import { type SignBidirectionalEvent, TxParamType } from "./signet-requests.ts";

/**
 * Recover the address that produced a response signature, over the signing
 * digest of the transaction the request describes: the response-side
 * dispatch on the request's `txParamType`.
 *
 * @param request - The on-ledger request record the response answers.
 * @param response - The posted signature record answering it.
 * @returns The checksummed recovered signer address.
 * @throws {Error} If the request's `txParamType` names a decomposition this
 *   library does not sign-verify, the response is not a decodable signature,
 *   or the request record is malformed (see
 *   {@link signBidirectionalEventToUnsignedEvmTransaction}).
 */
export function recoverSignatureResponseSigner(
  request: SignBidirectionalEvent,
  response: SignatureRespondedEvent,
): string {
  switch (request.txParamType) {
    case TxParamType.evmType2:
      return recoverAddress(
        signBidirectionalEventToUnsignedEvmTransaction(request).unsignedHash,
        signatureRespondedEventToSignature(response),
      );
    default:
      throw new Error(`unsupported txParamType ${String(request.txParamType)}`);
  }
}

/**
 * Verify a posted response against its request: does the signature recover
 * to `expectedSigner`? Never throws: a malformed or wrongly-signed response
 * is simply not valid.
 *
 * @param request - The on-ledger request record the response answers.
 * @param response - The posted signature record answering it.
 * @param expectedSigner - The EVM address (any case, 0x hex) that must have signed.
 * @returns `true` iff the response is a valid signature by `expectedSigner`.
 */
export function verifySignatureRespondedEvent(
  request: SignBidirectionalEvent,
  response: SignatureRespondedEvent,
  expectedSigner: string,
): boolean {
  try {
    return recoverSignatureResponseSigner(request, response) === getAddress(expectedSigner);
  } catch {
    return false;
  }
}
