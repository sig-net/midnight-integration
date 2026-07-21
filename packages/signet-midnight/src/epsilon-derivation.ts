// Epsilon key derivation: contract address + path -> derived EVM account.
//
// This belongs in github.com/sig-net/signet.js — kept here until upstreamed.
// It is NOT imported from signet.js because signet.js's `deriveChildPublicKey`
// implements the v2.0.0 COLON-separated epsilon format
// (`sig.network v2.0.0 epsilon derivation:<chainId>:<requester>:<path>`),
// which is incompatible with the live sig-net response server's v1.0.0
// COMMA-separated format (see solana-signet-program
// clients/response-server/src/modules/CryptoUtils.ts). The two schemes hash
// different strings and therefore derive different accounts; this module
// matches the server.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { computeAddress, keccak256, SigningKey, toUtf8Bytes } from "ethers";

import { SECP256K1_ORDER, type Secp256k1Point } from "./ecdsa-attestation.ts";

/**
 * Domain prefix of the sig-net v1.0.0 epsilon derivation scheme, as used by
 * the live response server. The full derivation string is
 * `<prefix>,<chainId>,<requester>,<path>` (comma-separated).
 */
export const EPSILON_DERIVATION_PREFIX = "sig.network v1.0.0 epsilon derivation";

/**
 * CAIP-2 chain id under which the MPC derives keys for requests originating
 * from Midnight contracts.
 */
export const MIDNIGHT_TESTNET_CHAIN_ID = "midnight:testnet";

/**
 * The FIXED derivation path of the MPC's respond-bidirectional RESPONSE key
 * for Midnight client contracts (mirrors the MPC's per-chain
 * `<chain> response key` convention, sig-net/mpc
 * chain-signatures/node/src/respond_bidirectional.rs). The response key is
 * derived from (the SIGNET SINGLETON contract address, this path): it is not
 * the MPC root key and not the key that signs the requested transaction.
 * Client contracts pin its hash at deploy time and verify
 * RespondBidirectionalEvents against it.
 *
 * Why the SIGNET address and not the client contract's own address: the pin
 * is sealed in the client's CONSTRUCTOR, and a Midnight contract address is
 * a hash over the deploy (constructor arguments included), so a key derived
 * from the client's own address could never be known at the moment it must
 * be sealed. The signet singleton deploys first, so its address is available
 * to every client deploy, and the key stays scoped per signet deployment.
 */
export const MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH = "midnight response key";

/**
 * Derive the EVM address the MPC network signs from for a given Midnight
 * contract and derivation path, using the sig-net v1.0.0 epsilon scheme:
 * `epsilon = keccak256("<prefix>,<chainId>,<contractAddress>,<path>")` and
 * `derivedPubKey = mpcRootPubKey + epsilon * G` on secp256k1.
 *
 * The MPC treats `path` as an opaque string: the vault's own account uses the
 * literal path `"vault"`, a user's account uses the lowercase hex of their
 * identity commitment.
 *
 * @param mpcSecp256k1PubkeyHex - The MPC root secp256k1 public key as 0x-hex
 *   (compressed or uncompressed; normalized internally).
 * @param contractAddress - The Midnight contract address the request
 *   originates from (the "requester" in the derivation string).
 * @param path - The derivation path string (e.g. `"vault"` or a commitment
 *   hex).
 * @param chainId - CAIP-2 chain id component of the derivation string.
 * @returns The derived EVM address as a 0x-prefixed EIP-55 checksummed string.
 */
export function deriveEvmAddress(
  mpcSecp256k1PubkeyHex: string,
  contractAddress: string,
  path: string,
  chainId: string = MIDNIGHT_TESTNET_CHAIN_ID,
): string {
  const derivedPoint = deriveChildPoint(mpcSecp256k1PubkeyHex, contractAddress, path, chainId);
  return computeAddress(`0x${derivedPoint.toHex(false)}`);
}

/**
 * The epsilon scalar of the sig-net v1.0.0 derivation scheme:
 * `keccak256("<prefix>,<chainId>,<requester>,<path>")` reduced mod the
 * secp256k1 curve order. Child keys are `root + epsilon` (secret side) and
 * `rootPubKey + epsilon * G` (public side).
 *
 * @param requester - The requester component of the derivation string,
 *   verbatim (no normalisation: callers must agree on the exact rendering).
 * @param path - The derivation path string.
 * @param chainId - CAIP-2 chain id component of the derivation string.
 * @returns The epsilon scalar, in `[0, n)`.
 */
export function deriveEpsilon(
  requester: string,
  path: string,
  chainId: string = MIDNIGHT_TESTNET_CHAIN_ID,
): bigint {
  const fullPath = `${EPSILON_DERIVATION_PREFIX},${chainId},${requester},${path}`;
  // Reduce mod n before using: noble throws on scalars >= n, whereas the
  // server's scalar arithmetic reduces implicitly.
  return BigInt(keccak256(toUtf8Bytes(fullPath))) % SECP256K1_ORDER;
}

/** Derive the child public key as a noble curve point (internal shape). */
function deriveChildPoint(
  mpcSecp256k1PubkeyHex: string,
  requester: string,
  path: string,
  chainId: string,
) {
  const epsilon = deriveEpsilon(requester, path, chainId);
  const rootPubKeyHex = SigningKey.computePublicKey(mpcSecp256k1PubkeyHex, false);
  const rootPoint = secp256k1.Point.fromHex(rootPubKeyHex.slice(2));
  return epsilon === 0n ? rootPoint : rootPoint.add(secp256k1.Point.BASE.multiply(epsilon));
}

/**
 * Normalise a Midnight contract address for use as the requester component
 * of the derivation string: strip an optional `0x` prefix and lowercase.
 * Both sides of the protocol (the deploy pinning a key and the MPC signing
 * with it) derive through this, so the rendering always agrees.
 */
function normaliseRequesterAddress(contractAddress: string): string {
  const hex =
    contractAddress.startsWith("0x") || contractAddress.startsWith("0X")
      ? contractAddress.slice(2)
      : contractAddress;
  return hex.toLowerCase();
}

/**
 * Derive the MPC's respond-bidirectional RESPONSE key for a signet
 * deployment, public side: what client-contract deploys pin
 * (`MPC_RESPONSE_KEY`) and what response verification checks against. See
 * {@link MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH} for the scheme and why the
 * requester is the signet singleton's address.
 *
 * @param mpcSecp256k1PubkeyHex - The MPC root secp256k1 public key as 0x-hex
 *   (compressed or uncompressed).
 * @param signetContractAddress - The signet singleton's Midnight contract
 *   address (`0x` prefix optional, case-insensitive).
 * @returns The response public key as a Compact-runtime `Secp256k1Point`.
 */
export function deriveMidnightResponseKey(
  mpcSecp256k1PubkeyHex: string,
  signetContractAddress: string,
): Secp256k1Point {
  const point = deriveChildPoint(
    mpcSecp256k1PubkeyHex,
    normaliseRequesterAddress(signetContractAddress),
    MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH,
    MIDNIGHT_TESTNET_CHAIN_ID,
  );
  return { x: point.x, y: point.y, identity: false };
}

/**
 * Derive the MPC's respond-bidirectional RESPONSE key for a signet
 * deployment, secret side: `(rootSecret + epsilon) mod n`. MPC-side only
 * (the fakenet signer, test harnesses): a real client never holds the root
 * key. The result feeds `signAttestationDigest` directly.
 *
 * @param mpcRootSecretKey - The 32-byte MPC root secret key (big-endian, the
 *   standard secp256k1 encoding).
 * @param signetContractAddress - The signet singleton's Midnight contract
 *   address (`0x` prefix optional, case-insensitive).
 * @returns The 32-byte response secret key (big-endian).
 * @throws Error if the root key is not 32 bytes or the derived scalar is 0.
 */
export function deriveMidnightResponseSecretKey(
  mpcRootSecretKey: Uint8Array,
  signetContractAddress: string,
): Uint8Array {
  if (mpcRootSecretKey.length !== 32) {
    throw new Error(`MPC root secret key must be 32 bytes, got ${mpcRootSecretKey.length}`);
  }
  let root = 0n;
  for (const byte of mpcRootSecretKey) {
    root = (root << 8n) | BigInt(byte);
  }
  const epsilon = deriveEpsilon(
    normaliseRequesterAddress(signetContractAddress),
    MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH,
    MIDNIGHT_TESTNET_CHAIN_ID,
  );
  const child = (root + epsilon) % SECP256K1_ORDER;
  if (child === 0n) {
    throw new Error("derived response secret key is zero (invalid scalar)");
  }
  const out = new Uint8Array(32);
  let value = child;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}
