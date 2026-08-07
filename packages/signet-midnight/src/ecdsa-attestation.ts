// secp256k1 ECDSA helpers: the TS side of the respond-bidirectional
// attestation flow in Signet.compact: SIGNING (which needs the secret
// scalar, so it cannot be a circuit), key parsing/formatting, and the
// attestation digest's TS twin.
// Everything provable stays in Compact where possible: in-circuit
// verification is `verifyRespondBidirectionalEvent`. The digest circuit is
// size-generic and the compiler cannot export size-generic circuits
// top-level, so the digest is
// the ONE sanctioned TS twin here, pinned byte-for-byte against the
// fixed-width oracle circuits circuits.compact exports (see
// tests/ecdsa-attestation.test.ts).
//
// This belongs in github.com/sig-net/signet.js as its Midnight adapter,
// kept here until upstreamed.

import type { Secp256k1Point } from "@midnight-ntwrk/compact-runtime";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ethers } from "ethers";

import { bigintToBytes32BE, bytesToBigintBE, stripHexPrefix } from "./byte-codecs.ts";
import type { MpcSignature, RespondBidirectionalEvent } from "./signet-contract-events.ts";
import type { RequestId } from "./signet-requests.ts";

// Re-exported because it appears throughout this module's public signatures:
// SDK consumers shouldn't have to depend on compact-runtime just for the type.
export type { Secp256k1Point } from "@midnight-ntwrk/compact-runtime";

/** secp256k1 curve (group) order n. */
export const SECP256K1_ORDER = secp256k1.Point.Fn.ORDER;

/**
 * An ECDSA signature in scalar form: what {@link signAttestationDigest}
 * produces, and what {@link ecdsaSignatureToMpcSignature} encodes into the
 * stored form respond events carry.
 */
export interface EcdsaSignature {
  /** Signature scalar r (= R.x mod n). */
  r: bigint;
  /** Signature scalar s (low-s normalised by the signer). */
  s: bigint;
  /** Recovery id (parity of R.y): 0 or 1. */
  recoveryId: number;
}

/**
 * ECDSA-sign a 32-byte digest with a secp256k1 secret key, exactly as the
 * MPC signs the attestation digest: the result verifies in-circuit against
 * the matching public key. For posters and test fixtures.
 *
 * @param digest - The 32-byte digest to sign (e.g. the
 *   {@link calculateSignetAttestationDigest} output).
 * @param secretKey - The 32-byte secp256k1 secret key.
 * @returns The signature with its recovery id.
 * @throws {Error} If no recovery id reproduces the signer's own public key.
 */
export function signAttestationDigest(digest: Uint8Array, secretKey: Uint8Array): EcdsaSignature {
  const sigBytes = secp256k1.sign(digest, secretKey, { prehash: false });
  const sig = secp256k1.Signature.fromBytes(sigBytes, "compact");
  // Recover the id by trying both parities against the actual public key.
  const pk = secp256k1.getPublicKey(secretKey, false);
  const pkHex = Buffer.from(pk).toString("hex");
  for (const recoveryId of [0, 1]) {
    const recovered = sig.addRecoveryBit(recoveryId).recoverPublicKey(digest).toHex(false);
    if (recovered === pkHex) {
      return { r: sig.r, s: sig.s, recoveryId };
    }
  }
  /* v8 ignore next: unreachable for a signature this function just produced */
  throw new Error("signature does not recover to its own public key");
}

/**
 * Encode a scalar-form signature as the stored-form record both respond
 * events carry. For MPC-side posters (the fakenet signer) and test fixtures.
 *
 * @param signature - The scalar-form signature (the signer's output shape).
 * @returns The stored-form signature: R as a full point, big-endian bytes.
 * @throws {Error} If the recovery id is not 0 or 1, or `r` is not the x
 *   coordinate of a secp256k1 point.
 */
export function ecdsaSignatureToMpcSignature(signature: EcdsaSignature): MpcSignature {
  if (signature.recoveryId !== 0 && signature.recoveryId !== 1) {
    throw new Error(`expected a recovery id of 0 or 1, got ${String(signature.recoveryId)}`);
  }
  // SEC1 compressed form: parity prefix (02 even, 03 odd) || x big-endian.
  const parityPrefix = signature.recoveryId === 0 ? "02" : "03";
  const xHex = signature.r.toString(16).padStart(64, "0");
  let point;
  try {
    point = secp256k1.Point.fromHex(`${parityPrefix}${xHex}`);
  } catch (error) {
    throw new Error(`signature r is not the x coordinate of a secp256k1 point (${String(error)})`, {
      cause: error,
    });
  }
  const uncompressed = point.toBytes(false); // 0x04 || x || y
  return {
    bigR: { x: uncompressed.slice(1, 33), y: uncompressed.slice(33, 65) },
    s: bigintToBytes32BE(signature.s),
    recoveryId: BigInt(signature.recoveryId),
  };
}

/**
 * Decode a stored-form signature back to scalar form: the inverse of
 * {@link ecdsaSignatureToMpcSignature}, for off-chain consumers building a
 * transaction from the response. Checks shape only: acceptance does not mean
 * the signature verifies.
 *
 * @param signature - The stored-form signature as posted.
 * @returns The scalar-form signature.
 * @throws {Error} If a component has the wrong byte length or the recovery id
 *   is not 0 or 1.
 */
export function mpcSignatureToEcdsaSignature(signature: MpcSignature): EcdsaSignature {
  const { bigR, s, recoveryId } = signature;
  if (bigR.x.length !== 32 || bigR.y.length !== 32 || s.length !== 32) {
    throw new Error("expected 32-byte bigR.x/bigR.y/s in a stored signature");
  }
  if (recoveryId !== 0n && recoveryId !== 1n) {
    throw new Error(`expected a recovery id of 0 or 1, got ${String(recoveryId)}`);
  }
  return {
    r: bytesToBigintBE(bigR.x) % SECP256K1_ORDER,
    s: bytesToBigintBE(s),
    recoveryId: Number(recoveryId),
  };
}

/**
 * Parse a secp256k1 public key from SEC1 hex (compressed or uncompressed,
 * optional `0x` prefix) into the Compact runtime's `Secp256k1Point` shape:
 * how deploys receive the MPC response key to pin.
 *
 * @param value - The SEC1 hex public key.
 * @returns The parsed point.
 * @throws {Error} If the value is not a valid secp256k1 public key.
 */
export function parseSecp256k1PublicKey(value: string): Secp256k1Point {
  const hex = stripHexPrefix(value);
  let point;
  try {
    point = secp256k1.Point.fromHex(hex);
  } catch (error) {
    throw new Error(`not a secp256k1 public key in SEC1 hex: "${value}" (${String(error)})`, {
      cause: error,
    });
  }
  const uncompressed = point.toBytes(false); // 0x04 || x || y
  return {
    x: bytesToBigintBE(uncompressed.slice(1, 33)),
    y: bytesToBigintBE(uncompressed.slice(33, 65)),
    identity: false,
  };
}

/**
 * Format a secp256k1 public key point as uncompressed SEC1 hex (with `0x`
 * prefix): the round-trip inverse of {@link parseSecp256k1PublicKey}, for
 * handing a response key to deploys via env/config.
 *
 * @param point - The point to format.
 * @returns The `0x04…` uncompressed SEC1 hex string.
 */
export function formatSecp256k1PublicKey(point: Secp256k1Point): string {
  const toBE32 = (v: bigint): string => v.toString(16).padStart(64, "0");
  return `0x04${toBE32(point.x)}${toBE32(point.y)}`;
}

/**
 * Derive the `Secp256k1Point` of a secret key: a convenience for tests and
 * signers that hold key material as raw bytes.
 *
 * @param secretKey - The 32-byte secp256k1 secret key.
 * @returns The public key point.
 */
export function secp256k1PublicKeyOf(secretKey: Uint8Array): Secp256k1Point {
  const uncompressed = secp256k1.getPublicKey(secretKey, false);
  return {
    x: bytesToBigintBE(uncompressed.slice(1, 33)),
    y: bytesToBigintBE(uncompressed.slice(33, 65)),
    identity: false,
  };
}

/**
 * The attestation digest of a respond-bidirectional response:
 * `keccak256(requestId || serializedOutput)`, the 32-byte digest the MPC
 * ECDSA-signs to attest a remote execution. TS twin of the size-generic
 * Compact circuit of the same name, pinned against its fixed-width oracle
 * circuits in tests. The output is hashed as given, at its exact length:
 * no padding, no length prefix.
 *
 * @param requestId - The 32-byte request id the response answers.
 * @param serializedOutput - The serialised execution output, exact unpadded bytes.
 * @returns The 32-byte attestation digest.
 */
export function calculateSignetAttestationDigest(
  requestId: RequestId,
  serializedOutput: Uint8Array,
): Uint8Array {
  return ethers.getBytes(ethers.keccak256(ethers.concat([requestId, serializedOutput])));
}

/**
 * Off-chain twin of the in-circuit `verifyRespondBidirectionalEvent`: checks
 * a posted respond-bidirectional attestation against the execution output
 * and the contract's pinned MPC response key. Clients run it to sift
 * candidate posts before calling a contract: a post this accepts verifies
 * in-circuit. Malformed records return `false` rather than throwing.
 *
 * @param requestId - The 32-byte request id the response answers.
 * @param serializedOutput - The serialised execution output, exact unpadded bytes.
 * @param event - The posted record to check, as read off the ledger.
 * @param mpcResponseKey - The response key the requesting contract pinned
 *   (see {@link deriveMidnightResponseKey}).
 * @returns Whether the post is a genuine attestation of that output.
 */
export function verifyRespondBidirectionalSignature(
  requestId: RequestId,
  serializedOutput: Uint8Array,
  event: RespondBidirectionalEvent,
  mpcResponseKey: Secp256k1Point,
): boolean {
  let signature: EcdsaSignature;
  try {
    signature = mpcSignatureToEcdsaSignature(event.signature);
  } catch {
    return false;
  }
  const digest = calculateSignetAttestationDigest(requestId, serializedOutput);
  // Compact form the verifier takes: r || s big-endian, and the key as
  // uncompressed SEC1 (0x04 || x || y).
  const compactSignature = new Uint8Array(64);
  compactSignature.set(bigintToBytes32BE(signature.r), 0);
  compactSignature.set(bigintToBytes32BE(signature.s), 32);
  const publicKey = new Uint8Array(65);
  publicKey[0] = 0x04;
  publicKey.set(bigintToBytes32BE(mpcResponseKey.x), 1);
  publicKey.set(bigintToBytes32BE(mpcResponseKey.y), 33);
  try {
    return secp256k1.verify(compactSignature, digest, publicKey, {
      prehash: false,
      lowS: false,
    });
  } catch {
    return false;
  }
}
