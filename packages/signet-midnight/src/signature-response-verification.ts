// Client-side verification of MPC signature responses. The signet responder
// emits signature responses UNAUTHENTICATED (see the header of
// signet-responder.compact), so a poller must verify every posted response before
// trusting it.

import { getAddress, getBytes, recoverAddress } from "ethers";

import { signatureRespondedEventToSignature } from "./ecdsa-attestation.ts";
import type { SignatureRespondedEvent } from "./signet-contract-events.ts";
import { signBidirectionalEventToUnsignedEvmTransaction } from "./signet-evtype2tx-requests.ts";
import { type SignBidirectionalEvent, TxParamType } from "./signet-requests.ts";
import type { TronTxParams } from "./signet-tron-requests.ts";
import {
  buildTronRawTransaction,
  deriveSignBidirectionalEventSignerTronAddress,
  tronAddressFromEvm,
  tronAddressToBase58,
  tronTransactionId,
} from "./tron-transactions.ts";

function evmSigningHash(request: SignBidirectionalEvent): string {
  if (request.txParamType !== TxParamType.evmType2) {
    throw new Error(
      `expected an evmType2 request record, got txParamType ${String(request.txParamType)}`,
    );
  }
  return signBidirectionalEventToUnsignedEvmTransaction(request).unsignedHash;
}

function tronSigningHash(
  request: SignBidirectionalEvent<TronTxParams>,
  mpcRootPublicKey: string,
): { signingHash: Uint8Array; owner: Uint8Array } {
  if (request.txParamType !== TxParamType.tron) {
    throw new Error(
      `expected a Tron request record, got txParamType ${String(request.txParamType)}`,
    );
  }
  const owner = deriveSignBidirectionalEventSignerTronAddress(mpcRootPublicKey, request).bytes;
  return {
    signingHash: tronTransactionId(buildTronRawTransaction(request.txParams, owner)),
    owner,
  };
}

function signatureRecoversTo(
  signingHash: string | Uint8Array,
  response: SignatureRespondedEvent,
  expectedAddress: Uint8Array,
): boolean {
  let recovered: Uint8Array;
  try {
    recovered = getBytes(recoverAddress(signingHash, signatureRespondedEventToSignature(response)));
  } catch {
    return false;
  }
  return (
    recovered.length === expectedAddress.length &&
    recovered.every((byte, index) => byte === expectedAddress[index])
  );
}

/**
 * Recover the address that produced a response signature, over the signing
 * digest of the evmType2 transaction the request describes.
 *
 * @param request - The on-ledger evmType2 request record the response answers.
 * @param response - The posted signature record answering it.
 * @returns The checksummed recovered signer address.
 * @throws {Error} If the request is not an evmType2 record, the response
 *   is not a decodable signature,
 *   or the request record is malformed (see
 *   {@link signBidirectionalEventToUnsignedEvmTransaction}).
 */
export function recoverEvmSignatureResponseSigner(
  request: SignBidirectionalEvent,
  response: SignatureRespondedEvent,
): string {
  return recoverAddress(evmSigningHash(request), signatureRespondedEventToSignature(response));
}

/**
 * @param request - The on-ledger Tron request record the response answers
 * @param response - The posted signature record answering it
 * @param mpcRootPublicKey - The MPC root public key of the record's `keyVersion`; the transaction owner is derived from it and the record's `sender` and `path`
 * @returns The recovered signer as a base58 Tron address
 * @throws {Error} If the request is not a Tron record, the record does not assemble, the key does not parse or the response is not a decodable signature
 */
export function recoverTronSignatureResponseSigner(
  request: SignBidirectionalEvent<TronTxParams>,
  response: SignatureRespondedEvent,
  mpcRootPublicKey: string,
): string {
  const { signingHash } = tronSigningHash(request, mpcRootPublicKey);
  return tronAddressToBase58(
    tronAddressFromEvm(recoverAddress(signingHash, signatureRespondedEventToSignature(response))),
  );
}

/**
 * Verify a posted response against its evmType2 request: does the signature
 * recover to `expectedSigner`? A malformed or wrongly-signed response is
 * simply not valid.
 *
 * @param request - The on-ledger evmType2 request record the response answers.
 * @param response - The posted signature record answering it.
 * @param expectedSigner - The EVM address (any case, 0x hex) that must have signed.
 * @returns `true` iff the response is a valid signature by `expectedSigner`.
 * @throws {Error} If the request is not an evmType2 record, the record does
 *   not assemble, or `expectedSigner` is not an EVM address.
 */
export function verifyEvmSignatureRespondedEvent(
  request: SignBidirectionalEvent,
  response: SignatureRespondedEvent,
  expectedSigner: string,
): boolean {
  const signingHash = evmSigningHash(request);
  return signatureRecoversTo(signingHash, response, getBytes(getAddress(expectedSigner)));
}

/**
 * @param request - The on-ledger Tron request record the response answers
 * @param response - The posted signature record answering it
 * @param mpcRootPublicKey - The MPC root public key of the record's `keyVersion`; the expected owner is derived from it and the record's `sender` and `path`
 * @returns `true` iff the response is a valid signature by the derived owner
 * @throws {Error} If the request is not a Tron record, the record does not assemble or the key does not parse
 */
export function verifyTronSignatureRespondedEvent(
  request: SignBidirectionalEvent<TronTxParams>,
  response: SignatureRespondedEvent,
  mpcRootPublicKey: string,
): boolean {
  const { signingHash, owner } = tronSigningHash(request, mpcRootPublicKey);
  return signatureRecoversTo(signingHash, response, owner.slice(1));
}
