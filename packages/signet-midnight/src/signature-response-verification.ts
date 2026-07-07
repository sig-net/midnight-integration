// Client-side verification of MPC signature responses. Posting to the
// signet contract's signature response log is UNAUTHENTICATED (see "Signet
// Layout" in Signet.compact), so a poller must verify every posted response
// before trusting it: rebuild the unsigned EVM transaction from the on-ledger
// request record — assembled exactly as the MPC assembles it (sig-net/mpc
// response server, managed/erc20-vault/signet/calldata-builder.ts) — and
// check that the 65-byte `r || s || v` response signature recovers to the
// requester's derived EVM address over that transaction's signing hash.

import { getAddress, recoverAddress } from "ethers";

import {
  signetEVMSignatureRequestToUnsignedEVMTransaction,
  signetEVMSignatureResponseToSignature,
  type SignetEVMSignatureRequest,
} from "./signet-requests.ts";
import type { SignetEVMSignatureResponse } from "./signet-contract-state-reader.ts";

/**
 * Recover the EVM address that produced a response signature, over the
 * signing hash of the transaction the request describes.
 *
 * @param request - The on-ledger request record the response answers.
 * @param response - The 65-byte `r || s || v` response signature (`v` may be
 *   a recovery id 0/1 or the legacy 27/28).
 * @returns The checksummed recovered signer address.
 * @throws Error if the response is not 65 bytes, is not a decodable
 *   signature, or the request record is malformed (see
 *   {@link signetEVMSignatureRequestToUnsignedEVMTransaction}).
 */
export function recoverSignetEVMSignatureResponseSigner(
  request: SignetEVMSignatureRequest,
  response: SignetEVMSignatureResponse,
): string {
  return recoverAddress(
    signetEVMSignatureRequestToUnsignedEVMTransaction(request).unsignedHash,
    signetEVMSignatureResponseToSignature(response),
  );
}

/**
 * Verify a posted response against its request: does the signature recover
 * to `expectedSigner`? Never throws — a response that is malformed or signed
 * by anyone else is simply not valid, which is the expected state of affairs
 * on an unauthenticated log.
 *
 * @param request - The on-ledger request record the response answers.
 * @param response - The 65-byte `r || s || v` response signature.
 * @param expectedSigner - The EVM address (any case, 0x hex) that must have signed.
 * @returns `true` iff the response is a valid signature by `expectedSigner`.
 */
export function verifySignetEVMSignatureResponse(
  request: SignetEVMSignatureRequest,
  response: SignetEVMSignatureResponse,
  expectedSigner: string,
): boolean {
  try {
    return (
      recoverSignetEVMSignatureResponseSigner(request, response) ===
      getAddress(expectedSigner)
    );
  } catch {
    return false;
  }
}
