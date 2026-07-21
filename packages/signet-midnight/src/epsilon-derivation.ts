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
 * `<chain> response key` convention — sig-net/mpc
 * chain-signatures/node/src/respond_bidirectional.rs). The response key is
 * derived per client contract from (contract address, this path) — it is not
 * the MPC root key and not the key that signs the requested transaction.
 * Client contracts pin its hash at deploy time and verify
 * RespondBidirectionalEvents against it.
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
  const fullPath = `${EPSILON_DERIVATION_PREFIX},${chainId},${contractAddress},${path}`;
  // Reduce mod n before multiplying: noble throws on scalars >= n, whereas the
  // server's scalar arithmetic reduces implicitly.
  const epsilon = BigInt(keccak256(toUtf8Bytes(fullPath))) % secp256k1.Point.Fn.ORDER;
  const rootPubKeyHex = SigningKey.computePublicKey(mpcSecp256k1PubkeyHex, false);
  const rootPoint = secp256k1.Point.fromHex(rootPubKeyHex.slice(2));
  const derivedPoint = epsilon === 0n ? rootPoint : rootPoint.add(secp256k1.Point.BASE.multiply(epsilon));
  return computeAddress(`0x${derivedPoint.toHex(false)}`);
}
