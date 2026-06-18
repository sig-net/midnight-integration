import {
  persistentHash,
  CompactTypeBytes,
  CompactTypeVector,
} from '@midnight-ntwrk/compact-runtime';
import { ethers } from 'ethers';
import * as ecc from 'tiny-secp256k1';

const bytes32Type = new CompactTypeBytes(32);
const vec2Type = new CompactTypeVector(2, bytes32Type);

export const EPSILON_PREFIX = 'sig.network v1.0.0 epsilon derivation';
export const GENESIS_MINT_WALLET_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

export function hash2x32(a: Uint8Array, b: Uint8Array): Uint8Array {
  return persistentHash(vec2Type, [a, b]);
}

export function pad32(str: string): Uint8Array {
  const padded = new Uint8Array(32);
  new TextEncoder().encodeInto(str, padded);
  return padded;
}

export function padN(n: number, str: string): Uint8Array {
  const padded = new Uint8Array(n);
  new TextEncoder().encodeInto(str, padded);
  return padded;
}

export function deriveEvmAddress(
  mpcPubKeyHex: string,
  contractAddr: string,
  derivationPath: string,
  chainId: string = 'midnight:testnet',
): string {
  const fullPath = `${EPSILON_PREFIX},${chainId},${contractAddr},${derivationPath}`;
  const epsilonHash = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(fullPath)));
  const rootPubBytes = ethers.getBytes(ethers.SigningKey.computePublicKey(mpcPubKeyHex, false));
  const derivedPubKey = ecc.pointAddScalar(rootPubBytes, epsilonHash, false);
  if (!derivedPubKey) throw new Error('EC point addition failed');
  return ethers.computeAddress(ethers.hexlify(derivedPubKey));
}
