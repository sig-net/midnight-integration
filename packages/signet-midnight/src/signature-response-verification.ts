// Client-side verification of MPC signature responses. The signet contract
// emits signature responses UNAUTHENTICATED (see the module header in
// Signet.compact), so a poller must verify every posted response
// before trusting it: rebuild the unsigned EVM transaction from the on-ledger
// request record, assembled exactly as the MPC assembles it (sig-net/mpc
// response server, managed/erc20-vault/signet/calldata-builder.ts), and
// check that the posted signature record recovers to the requester's derived
// EVM address over that transaction's signing hash.

import { getAddress, recoverAddress } from "ethers";

import type { SignatureRespondedEvent } from "./signet-contract-events.ts";
import {
  signatureRespondedEventToSignature,
  signBidirectionalEventToUnsignedEvmTransaction,
} from "./signet-evtype2tx-requests.ts";
import type { SignBidirectionalEvent } from "./signet-requests.ts";

/**
 * Recover the EVM address that produced a response signature, over the
 * signing hash of the transaction the request describes.
 *
 * @param request - The on-ledger request record the response answers.
 * @param response - The posted signature record answering it.
 * @returns The checksummed recovered signer address.
 * @throws {Error} If the response is not a decodable signature or the request
 *   record is malformed (see
 *   {@link signBidirectionalEventToUnsignedEvmTransaction}).
 */
export function recoverSignatureResponseSigner(
  request: SignBidirectionalEvent,
  response: SignatureRespondedEvent,
): string {
  return recoverAddress(
    signBidirectionalEventToUnsignedEvmTransaction(request).unsignedHash,
    signatureRespondedEventToSignature(response),
  );
}

/**
 * Verify a posted response against its request: does the signature recover
 * to `expectedSigner`? Never throws: a response that is malformed or signed
 * by anyone else is simply not valid, which is the expected state of affairs
 * on an unauthenticated log.
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
