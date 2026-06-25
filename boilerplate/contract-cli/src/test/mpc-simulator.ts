/**
 * Local MPC simulator for the api integration tests.
 *
 * Behaves like the real signet response server, but pointed at the local Hardhat node:
 * it READS a pending request from the contract's on-chain signet ledger, builds the EVM
 * transaction from those contract-controlled params (the real MPC tx-builder), signs it
 * with the epsilon-derived secp256k1 key for the request's path, broadcasts it to the
 * local EVM, observes the real result, then Schnorr-signs (requestId, hash(outputData))
 * so the contract's claim()/completeWithdraw() can verify it. Nothing is hand-crafted —
 * the MPC only signs what it can read on-chain and what actually executed on the EVM.
 */
import { ethers } from 'ethers';
import { buildTransactionFromRequest } from '../signet/calldata-builder';
import type { SigningRequest } from '../signet/types';
import { schnorrSign, buildSignetMessage } from '../signet/schnorr';
import { calldataArgKey } from '../signet/request-id';
import { schnorrChallenge } from '../api';
import { EPSILON_PREFIX } from '../crypto-utils';
import { OUTPUT_DATA_SIZE } from '../signet/constants';

const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

/** Decode a contract-stored, zero-padded ASCII field (Bytes<N>) back to a string. */
const decodePadded = (b: Uint8Array): string => {
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;
  return new TextDecoder().decode(b.subarray(0, end));
};

/**
 * Epsilon-derive the secp256k1 PRIVATE key for a derivation path. Mirrors
 * crypto-utils.deriveEvmAddress (which adds epsilon·G to the root PUBLIC key): the
 * matching private key is rootPriv + epsilon (mod n), where epsilon = keccak256(fullPath).
 */
export const deriveEvmPrivKey = (
  rootPrivHex: string,
  contractAddr: string,
  derivationPath: string,
  chainId = 'midnight:testnet',
): string => {
  const fullPath = `${EPSILON_PREFIX},${chainId},${contractAddr},${derivationPath}`;
  const epsilon = BigInt(ethers.keccak256(ethers.toUtf8Bytes(fullPath)));
  const rootPriv = BigInt(rootPrivHex.startsWith('0x') ? rootPrivHex : '0x' + rootPrivHex);
  const derived = (rootPriv + epsilon) % SECP256K1_N;
  return '0x' + derived.toString(16).padStart(64, '0');
};

/** Read a pending signing request from the contract's signet ledger by requestId. */
export const readSigningRequest = (ledger: any, rid: Uint8Array): SigningRequest => {
  const argCount = Number(ledger.signetCalldataArgCount.lookup(rid));
  const args: Uint8Array[] = [];
  for (let i = 0; i < argCount; i++) {
    args.push(ledger.signetCalldataArgs.lookup(calldataArgKey(rid, i)));
  }
  return {
    predecessor: '',
    requestId: rid,
    nonce: ledger.signetRequestNonce.lookup(rid),
    evmParams: {
      evmTo: ledger.signetEvmTo.lookup(rid),
      evmChainId: ledger.signetEvmChainId.lookup(rid),
      evmNonce: ledger.signetEvmNonce.lookup(rid),
      evmGasLimit: ledger.signetEvmGasLimit.lookup(rid),
      evmMaxFee: ledger.signetEvmMaxFee.lookup(rid),
      evmPriorityFee: ledger.signetEvmPriorityFee.lookup(rid),
      evmValue: ledger.signetEvmValue.lookup(rid),
    },
    calldata: {
      funcSig: decodePadded(ledger.signetCalldataFuncSig.lookup(rid)),
      argCount,
      args,
    },
    caip2Id: decodePadded(ledger.signetCaip2Id.lookup(rid)),
    keyVersion: Number(ledger.signetKeyVersion.lookup(rid)),
    path: ledger.signetPath.lookup(rid),
    algo: decodePadded(ledger.signetAlgo.lookup(rid)),
    dest: decodePadded(ledger.signetDest.lookup(rid)),
    params: ledger.signetParams.lookup(rid),
    outputDeserializationSchema: ledger.signetOutputSchema.lookup(rid),
    respondSerializationSchema: ledger.signetRespondSchema.lookup(rid),
  };
};

export interface MpcResult {
  /** outputData the contract verifies: outputData[0] === 1 ⇔ EVM success. */
  outputData: Uint8Array;
  announcement: { x: bigint; y: bigint };
  response: bigint;
  /** true if the broadcast EVM transfer executed successfully. */
  success: boolean;
  evmTxHash: string;
}

/**
 * Simulate the MPC: read the request, build + sign the EVM tx from on-chain params,
 * broadcast to the local EVM, observe success, and Schnorr-sign the response.
 */
export const simulateMpcResponse = async (opts: {
  ledger: any;
  contractAddress: string;
  rid: Uint8Array;
  provider: ethers.JsonRpcProvider;
  secp256k1RootPriv: string;
  jubjubSk: bigint;
}): Promise<MpcResult> => {
  const { ledger, contractAddress, rid, provider, secp256k1RootPriv, jubjubSk } = opts;

  const request = readSigningRequest(ledger, rid);
  const pathStr = decodePadded(request.path);

  // Build the unsigned EIP-1559 tx from the contract-stored params (the real MPC builder).
  const unsigned = buildTransactionFromRequest(request);

  // Sign it with the path's epsilon-derived secp256k1 key, then broadcast.
  const privKey = deriveEvmPrivKey(secp256k1RootPriv, contractAddress, pathStr);
  const signingKey = new ethers.SigningKey(privKey);
  const tx = ethers.Transaction.from(ethers.hexlify(unsigned));
  tx.signature = signingKey.sign(tx.unsignedHash);

  let success: boolean;
  let evmTxHash = '';
  try {
    const resp = await provider.broadcastTransaction(tx.serialized);
    evmTxHash = resp.hash;
    const receipt = await resp.wait();
    success = receipt?.status === 1;
  } catch {
    // Broadcast/exec rejected (revert, bad nonce, insufficient funds) → EVM failure.
    success = false;
  }

  // Encode the observed result the way the contract reads it (outputData[0] === 1 ⇔ success).
  const outputData = new Uint8Array(OUTPUT_DATA_SIZE);
  if (success) outputData[0] = 1;

  // Schnorr-sign (requestId, hash(outputData)) as the MPC's authorization.
  const sig = schnorrSign(jubjubSk, buildSignetMessage(rid, outputData), schnorrChallenge);
  return { outputData, announcement: sig.announcement, response: sig.response, success, evmTxHash };
};
