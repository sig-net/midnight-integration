// Client-side verification of MPC signature responses. The signet responder
// emits signature responses UNAUTHENTICATED (see the header of
// signet-responder.compact), so a poller must verify every posted response before
// trusting it.

import { getAddress, getBytes, recoverAddress } from "ethers";

import { signatureRespondedEventToSignature } from "./ecdsa-attestation.ts";
import type { SignatureRespondedEvent } from "./signet-contract-events.ts";
import { signBidirectionalEventToUnsignedEvmTransaction } from "./signet-evtype2tx-requests.ts";
import { type AnySignBidirectionalEvent, isEvmRequest, isTronRequest } from "./signet-requests.ts";
import {
  buildTronRawTransaction,
  deriveSignBidirectionalEventSignerTronAddress,
  tronAddressFromEvm,
  tronAddressToBase58,
  tronTransactionId,
} from "./tron-transactions.ts";

function evmSigningHash(request: AnySignBidirectionalEvent): string {
  if (!isEvmRequest(request)) {
    throw new Error(
      `expected an evmType2 request record, got txParamType ${String(request.txParamType)}`,
    );
  }
  return signBidirectionalEventToUnsignedEvmTransaction(request).unsignedHash;
}

function tronSigningHash(
  request: AnySignBidirectionalEvent,
  mpcRootPublicKey: string,
): { signingHash: Uint8Array; owner: Uint8Array } {
  if (!isTronRequest(request)) {
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

/** What a signature response is checked against: the digest the MPC signs and the address that must have signed it. */
export interface SignatureCheck {
  /** The signing digest of the request's transaction. */
  readonly signingHash: string | Uint8Array;
  /** The 20-byte EVM form of the address that must have signed. */
  readonly expectedAddress: Uint8Array;
}

/**
 * Build the check of an evmType2 request's responses.
 *
 * @param request - The on-ledger evmType2 request record the responses answer
 * @param expectedSigner - The EVM address (0x hex, any case, checksum not enforced) that must have signed
 * @returns The check
 * @throws {Error} If the request is not an evmType2 record, the record does not assemble, or `expectedSigner` is not an EVM address
 */
export function evmSignatureCheck(
  request: AnySignBidirectionalEvent,
  expectedSigner: string,
): SignatureCheck {
  return {
    signingHash: evmSigningHash(request),
    expectedAddress: getBytes(getAddress(expectedSigner.toLowerCase())),
  };
}

/**
 * Build the check of a Tron request's responses.
 *
 * @param request - The on-ledger Tron request record the responses answer
 * @param mpcRootPublicKey - The MPC root public key of the record's `keyVersion`; the transaction owner is derived from it and the record's `sender` and `path`
 * @returns The check
 * @throws {Error} If the request is not a Tron record, the record does not assemble or the key does not parse
 */
export function tronSignatureCheck(
  request: AnySignBidirectionalEvent,
  mpcRootPublicKey: string,
): SignatureCheck {
  const { signingHash, owner } = tronSigningHash(request, mpcRootPublicKey);
  return { signingHash, expectedAddress: owner.slice(1) };
}

/**
 * Recover the 20-byte address that produced a response signature over a digest.
 *
 * @param signingHash - The digest the signature is over
 * @param response - The posted signature record
 * @returns The recovered 20-byte address
 * @throws {Error} If the response is not a decodable signature
 */
export function recoverSignatureAddress(
  signingHash: string | Uint8Array,
  response: SignatureRespondedEvent,
): Uint8Array {
  return getBytes(recoverAddress(signingHash, signatureRespondedEventToSignature(response)));
}

/**
 * Compare a recovered address with a check's expected address, byte for byte.
 *
 * @param check - The check the response is judged by
 * @param recovered - The recovered 20-byte address
 * @returns `true` iff the addresses are equal
 */
export function isExpectedSigner(check: SignatureCheck, recovered: Uint8Array): boolean {
  const expected = check.expectedAddress;
  return (
    recovered.length === expected.length &&
    recovered.every((byte, index) => byte === expected[index])
  );
}

function signatureRecoversTo(check: SignatureCheck, response: SignatureRespondedEvent): boolean {
  let recovered: Uint8Array;
  try {
    recovered = recoverSignatureAddress(check.signingHash, response);
  } catch {
    return false;
  }
  return isExpectedSigner(check, recovered);
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
  request: AnySignBidirectionalEvent,
  response: SignatureRespondedEvent,
): string {
  return recoverAddress(evmSigningHash(request), signatureRespondedEventToSignature(response));
}

/**
 * Recover the address that produced a response signature, over the id of the Tron transaction the request describes.
 *
 * @param request - The on-ledger Tron request record the response answers
 * @param response - The posted signature record answering it
 * @param mpcRootPublicKey - The MPC root public key of the record's `keyVersion`; the transaction owner is derived from it and the record's `sender` and `path`
 * @returns The recovered signer as a base58 Tron address
 * @throws {Error} If the request is not a Tron record, the record does not assemble, the key does not parse or the response is not a decodable signature
 */
export function recoverTronSignatureResponseSigner(
  request: AnySignBidirectionalEvent,
  response: SignatureRespondedEvent,
  mpcRootPublicKey: string,
): string {
  const { signingHash } = tronSigningHash(request, mpcRootPublicKey);
  return tronAddressToBase58(tronAddressFromEvm(recoverSignatureAddress(signingHash, response)));
}

/**
 * Verify a posted response against its evmType2 request: does the signature
 * recover to `expectedSigner`? A malformed or wrongly-signed response is
 * simply not valid.
 *
 * @param request - The on-ledger evmType2 request record the response answers.
 * @param response - The posted signature record answering it.
 * @param expectedSigner - The EVM address (0x hex, any case, checksum not enforced) that must have signed.
 * @returns `true` iff the response is a valid signature by `expectedSigner`.
 * @throws {Error} If the request is not an evmType2 record, the record does
 *   not assemble, or `expectedSigner` is not an EVM address.
 */
export function verifyEvmSignatureRespondedEvent(
  request: AnySignBidirectionalEvent,
  response: SignatureRespondedEvent,
  expectedSigner: string,
): boolean {
  return signatureRecoversTo(evmSignatureCheck(request, expectedSigner), response);
}

/**
 * Verify a posted response against its Tron request: does the signature recover to the transaction's owner?
 *
 * @param request - The on-ledger Tron request record the response answers
 * @param response - The posted signature record answering it
 * @param mpcRootPublicKey - The MPC root public key of the record's `keyVersion`; the expected owner is derived from it and the record's `sender` and `path`
 * @returns `true` iff the response is a valid signature by the derived owner
 * @throws {Error} If the request is not a Tron record, the record does not assemble or the key does not parse
 */
export function verifyTronSignatureRespondedEvent(
  request: AnySignBidirectionalEvent,
  response: SignatureRespondedEvent,
  mpcRootPublicKey: string,
): boolean {
  return signatureRecoversTo(tronSignatureCheck(request, mpcRootPublicKey), response);
}
