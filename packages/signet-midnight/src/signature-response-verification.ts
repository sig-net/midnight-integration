// Client-side verification of MPC signature responses. Posting to the
// signature-responses contract is UNAUTHENTICATED (see "Response Ledger
// Layout" in Signet.compact), so a poller must verify every posted response
// before trusting it: rebuild the unsigned EVM transaction from the on-ledger
// request record — assembled exactly as the MPC assembles it (sig-net/mpc
// response server, managed/erc20-vault/signet/calldata-builder.ts) — and
// check that the 65-byte `r || s || v` response signature recovers to the
// requester's derived EVM address over that transaction's signing hash.

import {
  getAddress,
  Interface,
  recoverAddress,
  Signature,
  Transaction,
} from "ethers";

import { bytesToBigint } from "./schnorr.ts";
import {
  bytesToHex,
  type SignetEVMSignatureRequest,
} from "./signet-requests.ts";
import type { SignetEVMSignatureResponse } from "./signature-responses-state-reader.ts";

/**
 * Decode a zero-padded ASCII field (Compact's `pad(N, "text")` convention)
 * back to its string.
 *
 * @param bytes - The zero-padded ASCII bytes.
 * @returns The text before the first zero byte.
 */
function asciiUnpadded(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/**
 * Decode one contract-stored ABI arg slot into the JS value ethers encodes
 * for that ABI type. Compact stores every slot as `Bytes<32>` via
 * `as Field as Bytes<32>` — a LITTLE-ENDIAN field embed — so numeric kinds
 * (and addresses, which travel as `Bytes<20> as Field`) decode via
 * little-endian bigint, NOT as a big-endian ABI word. Mirrors
 * `decodeArgForType` in the MPC's calldata builder.
 *
 * @param abiType - The ABI type named in the function signature.
 * @param word - The 32-byte stored arg slot.
 * @returns The value to hand to `Interface.encodeFunctionData`.
 */
function decodeAbiArg(abiType: string, word: Uint8Array): string | bigint {
  if (abiType === "address") {
    const value = bytesToBigint(word);
    return getAddress(`0x${value.toString(16).padStart(40, "0").slice(-40)}`);
  }
  if (abiType.startsWith("uint") || abiType.startsWith("int")) {
    return bytesToBigint(word);
  }
  if (abiType === "bool") {
    return bytesToBigint(word) === 0n ? 0n : 1n;
  }
  return `0x${bytesToHex(word)}`;
}

/**
 * Rebuild the unsigned EIP-1559 transaction a request record describes,
 * byte-identical to the one the MPC assembles and signs: ABI calldata from
 * the stored function signature and arg slots, plus the stored gas and
 * routing fields.
 *
 * @param request - The on-ledger request record.
 * @returns The unsigned ethers transaction (`unsignedHash` is the digest the
 *   MPC signs).
 * @throws Error if the stored function signature cannot be parsed or its
 *   parameter count disagrees with the stored `argCount`.
 */
export function buildUnsignedEvmTransaction(
  request: SignetEVMSignatureRequest,
): Transaction {
  const funcSig = asciiUnpadded(request.calldata.funcSig);
  const iface = new Interface([`function ${funcSig}`]);
  const fragment = iface.getFunction(funcSig.split("(")[0]);
  if (fragment === null) {
    throw new Error(`cannot parse function signature "${funcSig}"`);
  }
  if (BigInt(fragment.inputs.length) !== request.calldata.argCount) {
    throw new Error(
      `function signature "${funcSig}" takes ${fragment.inputs.length} args ` +
        `but the request stores argCount ${request.calldata.argCount}`,
    );
  }
  const args = fragment.inputs.map((input, i) =>
    decodeAbiArg(input.type, request.calldata.args[i]),
  );
  return Transaction.from({
    type: 2,
    chainId: request.evmTransaction.chainId,
    nonce: Number(request.evmTransaction.nonce),
    gasLimit: request.evmTransaction.gasLimit,
    maxFeePerGas: request.evmTransaction.maxFeePerGas,
    maxPriorityFeePerGas: request.evmTransaction.maxPriorityFeePerGas,
    to: getAddress(`0x${bytesToHex(request.evmTransaction.to)}`),
    value: request.evmTransaction.value,
    data: iface.encodeFunctionData(fragment, args),
  });
}

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
 *   {@link buildUnsignedEvmTransaction}).
 */
export function recoverSignetEVMSignatureResponseSigner(
  request: SignetEVMSignatureRequest,
  response: SignetEVMSignatureResponse,
): string {
  if (response.length !== 65) {
    throw new Error(
      `expected a 65-byte r||s||v signature, got ${response.length} bytes`,
    );
  }
  const v = response[64];
  const signature = Signature.from({
    r: `0x${bytesToHex(response.subarray(0, 32))}`,
    s: `0x${bytesToHex(response.subarray(32, 64))}`,
    v: v < 27 ? v + 27 : v,
  });
  return recoverAddress(
    buildUnsignedEvmTransaction(request).unsignedHash,
    signature,
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
