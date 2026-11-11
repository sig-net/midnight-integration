// Client-side verification of MPC signature responses. The signet responder
// emits signature responses UNAUTHENTICATED (see the header of
// signet-responder.compact), so a poller must verify every posted response before
// trusting it.

import { getAddress, recoverAddress } from "ethers";

import { signatureRespondedEventToSignature } from "./ecdsa-attestation.ts";
import type { SignatureRespondedEvent } from "./signet-contract-events.ts";
import { signBidirectionalEventToUnsignedEvmTransaction } from "./signet-evtype2tx-requests.ts";
import {
  type AnySignBidirectionalEvent,
  isEvmType2SignBidirectionalEvent,
  type SignBidirectionalEvent,
} from "./signet-requests.ts";
import type { TronTxParams } from "./signet-tron-requests.ts";
import {
  buildTronRawTransaction,
  tronAddressFromBase58,
  tronAddressFromEvm,
  tronAddressToBase58,
  tronTransactionId,
} from "./tron-transactions.ts";

/**
 * Recover the address that produced a response signature, over the signing
 * digest of the EVM transaction the request describes. A Tron request has no
 * owner-free signing digest: its transaction id names the owner, so recover
 * with {@link recoverTronSignatureResponseSigner}.
 *
 * @param request - The on-ledger request record the response answers.
 * @param response - The posted signature record answering it.
 * @returns The checksummed recovered signer address.
 * @throws {Error} If the request is not an evmType2 record, the response is
 *   not a decodable signature, or the request record is malformed (see
 *   {@link signBidirectionalEventToUnsignedEvmTransaction}).
 */
export function recoverSignatureResponseSigner(
  request: AnySignBidirectionalEvent,
  response: SignatureRespondedEvent,
): string {
  if (!isEvmType2SignBidirectionalEvent(request)) {
    throw new Error(`unsupported txParamType ${String(request.txParamType)}`);
  }
  return recoverAddress(
    signBidirectionalEventToUnsignedEvmTransaction(request).unsignedHash,
    signatureRespondedEventToSignature(response),
  );
}

/**
 * Recover the Tron address that produced a response signature over the id of
 * the transaction a Tron request describes, assembled with `owner` as its
 * owner (see `buildTronRawTransaction`).
 *
 * @param request - The on-ledger Tron request record the response answers.
 * @param response - The posted signature record answering it.
 * @param owner - The base58 Tron address the transaction is assembled from:
 *   the request's derived address (see `deriveTronAddress`).
 * @returns The recovered signer as a base58 Tron address.
 * @throws {Error} If `owner` is not a Tron address, the record does not
 *   assemble into a transaction, or the response is not a decodable
 *   signature.
 */
export function recoverTronSignatureResponseSigner(
  request: SignBidirectionalEvent<TronTxParams>,
  response: SignatureRespondedEvent,
  owner: string,
): string {
  const txid = tronTransactionId(
    buildTronRawTransaction(request.txParams, tronAddressFromBase58(owner)),
  );
  return tronAddressToBase58(
    tronAddressFromEvm(recoverAddress(txid, signatureRespondedEventToSignature(response))),
  );
}

/**
 * Verify a posted response against its evmType2 request: does the signature
 * recover to `expectedSigner`? Never throws: a malformed or wrongly-signed
 * response, or a request of another decomposition, is simply not valid.
 *
 * @param request - The on-ledger request record the response answers.
 * @param response - The posted signature record answering it.
 * @param expectedSigner - The EVM address (any case, 0x hex) that must have signed.
 * @returns `true` iff the response is a valid signature by `expectedSigner`.
 */
export function verifySignatureRespondedEvent(
  request: AnySignBidirectionalEvent,
  response: SignatureRespondedEvent,
  expectedSigner: string,
): boolean {
  try {
    return recoverSignatureResponseSigner(request, response) === getAddress(expectedSigner);
  } catch {
    return false;
  }
}

/**
 * Verify a posted response against its Tron request: does the signature over
 * the id of the transaction owned by `expectedOwner` recover to
 * `expectedOwner`? Never throws: a malformed or wrongly-signed response is
 * simply not valid.
 *
 * @param request - The on-ledger Tron request record the response answers.
 * @param response - The posted signature record answering it.
 * @param expectedOwner - The base58 Tron address that must have signed: the
 *   request's derived address (see `deriveTronAddress`).
 * @returns `true` iff the response is a valid signature by `expectedOwner`.
 */
export function verifyTronSignatureRespondedEvent(
  request: SignBidirectionalEvent<TronTxParams>,
  response: SignatureRespondedEvent,
  expectedOwner: string,
): boolean {
  try {
    return recoverTronSignatureResponseSigner(request, response, expectedOwner) === expectedOwner;
  } catch {
    return false;
  }
}
