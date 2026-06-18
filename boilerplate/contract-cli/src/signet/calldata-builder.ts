/**
 * Signet Standard Calldata Builder
 *
 * MPC-side module that reads calldata fields from a contract's ledger
 * and builds ABI-encoded calldata + an unsigned EIP-1559 transaction.
 *
 * The CONTRACT stores individual typed parameters, and the MPC
 * builds the transaction off-chain from those contract-controlled values.
 */

import { ethers } from 'ethers';
import type { SigningRequest } from './types';
import { buildUnsignedEip1559Tx, type EvmTxParams } from './tx-builder';
import { bytesToBigint } from './schnorr';

/**
 * Build ABI-encoded calldata from a signing request's calldata fields.
 *
 * Parses the function signature to determine arg types, then encodes
 * the raw Bytes<32> args according to those types.
 *
 * @param request The signing request with calldata fields
 * @returns ABI-encoded calldata (4-byte selector + encoded args)
 */
export function buildCalldata(request: SigningRequest): Uint8Array {
  const { funcSig, args } = request.calldata;

  // Parse function signature to get types
  const iface = new ethers.Interface([`function ${funcSig}`]);
  const funcName = funcSig.split('(')[0];
  const fragment = iface.getFunction(funcName);
  if (!fragment) {
    throw new Error(`Failed to parse function signature: ${funcSig}`);
  }

  // Convert raw Bytes<32> args to the appropriate types for ABI encoding
  const typedArgs = fragment.inputs.map((input, i) => {
    if (i >= args.length) {
      throw new Error(`Missing arg ${i} for function ${funcSig}`);
    }
    return decodeArgForType(input.type, args[i]);
  });

  // ABI encode
  const encoded = iface.encodeFunctionData(funcName, typedArgs);
  return new Uint8Array(Buffer.from(encoded.slice(2), 'hex'));
}

/**
 * Build a complete unsigned EIP-1559 transaction from a signing request.
 *
 * Combines the ABI-encoded calldata with the EVM gas parameters
 * to produce the full RLP-encoded unsigned transaction.
 *
 * @param request The signing request
 * @returns Unsigned serialized transaction (0x02 + RLP payload)
 */
export function buildTransactionFromRequest(request: SigningRequest): Uint8Array {
  const calldata = buildCalldata(request);

  const txParams: EvmTxParams = {
    chainId: request.evmParams.evmChainId,
    nonce: request.evmParams.evmNonce,
    maxPriorityFeePerGas: request.evmParams.evmPriorityFee,
    maxFeePerGas: request.evmParams.evmMaxFee,
    gasLimit: request.evmParams.evmGasLimit,
    to: request.evmParams.evmTo,
    value: request.evmParams.evmValue,
    data: calldata,
  };

  return buildUnsignedEip1559Tx(txParams);
}

/**
 * Decode a raw Bytes<32> arg into the appropriate JavaScript type
 * for ethers.js ABI encoding.
 *
 * Compact stores all args as Bytes<32> (via `as Field as Bytes<32>`).
 * The type from the function signature tells us how to interpret it.
 */
function decodeArgForType(abiType: string, rawArg: Uint8Array): string | bigint {
  if (abiType === 'address') {
    // Address: stored as Field → Bytes<32> (little-endian field repr).
    // Extract the address bytes: the original Bytes<20> was cast to Field then to Bytes<32>.
    // In Compact, "as Field as Bytes<32>" stores the value as a little-endian field element.
    const value = bytesToBigint(rawArg);
    // Convert to 20-byte address (take low 160 bits)
    const addrHex = value.toString(16).padStart(40, '0').slice(-40);
    return ethers.getAddress('0x' + addrHex);
  }

  if (abiType.startsWith('uint')) {
    // Unsigned integer: stored as Field → Bytes<32> (little-endian).
    return bytesToBigint(rawArg);
  }

  if (abiType.startsWith('int')) {
    // Signed integer: stored as Field → Bytes<32> (little-endian).
    // For signed types, interpret as two's complement if needed.
    return bytesToBigint(rawArg);
  }

  if (abiType === 'bytes32') {
    // Already the right size, return as hex string
    return '0x' + Buffer.from(rawArg).toString('hex');
  }

  if (abiType === 'bool') {
    return bytesToBigint(rawArg) !== 0n ? BigInt(1) : BigInt(0);
  }

  // For other types, return as hex (best effort)
  return '0x' + Buffer.from(rawArg).toString('hex');
}

