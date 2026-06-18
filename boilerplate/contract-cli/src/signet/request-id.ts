/**
 * Signet Standard Request ID
 *
 * Computes the request ID matching the Compact circuit's computation.
 * The request ID is a persistentHash of all signet fields including the nonce,
 * EVM gas params, calldata commitment, and routing fields.
 *
 * Convention (must match the Compact circuit):
 *   - Numeric types (nonce, chainId, etc.): convertFieldToBytes(32, value) → Bytes<32>
 *   - Bytes<32> fields (algo): included directly
 *   - Bytes<N> fields where N > 32: persistentHash(Bytes<N>, value) → Bytes<32>
 *   - All 18 Bytes<32> values combined as Vector<18, Bytes<32>> and hashed
 *
 * Compact circuit equivalent:
 *   persistentHash<Vector<18, Bytes<32>>>([
 *     nonceValue as Field as Bytes<32>,
 *     evmChainId as Field as Bytes<32>,
 *     evmNonce as Field as Bytes<32>,
 *     evmGasLimit as Field as Bytes<32>,
 *     evmMaxFee as Field as Bytes<32>,
 *     evmPriorityFee as Field as Bytes<32>,
 *     evmValue as Field as Bytes<32>,
 *     evmTo as Field as Bytes<32>,
 *     persistentHash<Bytes<256>>(calldataFuncSig),
 *     calldataArgsCommitment,
 *     persistentHash<Bytes<64>>(caip2Id),
 *     keyVersion as Field as Bytes<32>,
 *     persistentHash<Bytes<256>>(path),
 *     algo,
 *     persistentHash<Bytes<64>>(dest),
 *     persistentHash<Bytes<512>>(params),
 *     persistentHash<Bytes<256>>(outputSchema),
 *     persistentHash<Bytes<256>>(respondSchema),
 *   ])
 */

import {
  persistentHash,
  convertFieldToBytes,
  CompactTypeBytes,
  CompactTypeVector,
} from '@midnight-ntwrk/compact-runtime';
import { bytesToBigint } from './schnorr';

const bytes32 = new CompactTypeBytes(32);
const bytes64 = new CompactTypeBytes(64);
const bytes256 = new CompactTypeBytes(256);
const bytes512 = new CompactTypeBytes(512);
const vec18x32 = new CompactTypeVector(18, bytes32);
const vec2x32 = new CompactTypeVector(2, bytes32);

/** Input fields for request ID computation. */
export interface RequestIdFields {
  /** Per-request nonce value (from signetNonce counter). */
  nonce: bigint;
  /** EVM chain ID. */
  evmChainId: bigint;
  /** EVM transaction nonce. */
  evmNonce: bigint;
  /** Gas limit. */
  evmGasLimit: bigint;
  /** Max fee per gas (wei). */
  evmMaxFee: bigint;
  /** Max priority fee per gas (wei). */
  evmPriorityFee: bigint;
  /** ETH value (wei). */
  evmValue: bigint;
  /** Target EVM contract address — Bytes<20> zero-padded to 32 bytes via `as Field as Bytes<32>`. */
  evmTo: Uint8Array;
  /** Function signature — Bytes<256> buffer (pad(256, "transfer(address,uint256)")). */
  calldataFuncSig: Uint8Array;
  /** Commitment hash of all calldata args. */
  calldataArgsCommitment: Uint8Array;
  /** CAIP-2 chain identifier — Bytes<64> buffer. */
  caip2Id: Uint8Array;
  /** MPC key version (typically 0). */
  keyVersion: number;
  /** Derivation path — Bytes<256> buffer. */
  path: Uint8Array;
  /** Signing algorithm — Bytes<32> buffer. */
  algo: Uint8Array;
  /** Destination type — Bytes<64> buffer. */
  dest: Uint8Array;
  /** Additional parameters — Bytes<512> buffer. */
  params: Uint8Array;
  /** Output deserialization schema — Bytes<256> buffer. */
  outputSchema: Uint8Array;
  /** Response serialization schema — Bytes<256> buffer. */
  respondSchema: Uint8Array;
}

/**
 * Compute the signet standard request ID.
 *
 * Matches the Compact circuit's computation exactly. The client pre-computes
 * this and passes it to the circuit, which verifies it matches.
 * The MPC can also recompute it from the per-request map values to verify consistency.
 */
export function computeRequestId(fields: RequestIdFields): Uint8Array {
  const elements: Uint8Array[] = [
    // Numeric types: "as Field as Bytes<32>"
    convertFieldToBytes(32, fields.nonce, 'signet:nonce'),
    convertFieldToBytes(32, fields.evmChainId, 'signet:evmChainId'),
    convertFieldToBytes(32, fields.evmNonce, 'signet:evmNonce'),
    convertFieldToBytes(32, fields.evmGasLimit, 'signet:evmGasLimit'),
    convertFieldToBytes(32, fields.evmMaxFee, 'signet:evmMaxFee'),
    convertFieldToBytes(32, fields.evmPriorityFee, 'signet:evmPriorityFee'),
    convertFieldToBytes(32, fields.evmValue, 'signet:evmValue'),
    // evmTo: Bytes<20> → as Field as Bytes<32> (left-padded)
    convertFieldToBytes(32, bytesToBigint(fields.evmTo), 'signet:evmTo'),
    // calldataFuncSig: Bytes<256> → hash to Bytes<32>
    persistentHash(bytes256, fields.calldataFuncSig),
    // calldataArgsCommitment: already Bytes<32>
    fields.calldataArgsCommitment,
    // Routing fields
    persistentHash(bytes64, fields.caip2Id),
    convertFieldToBytes(32, BigInt(fields.keyVersion), 'signet:keyVersion'),
    persistentHash(bytes256, fields.path),
    fields.algo, // already Bytes<32>
    persistentHash(bytes64, fields.dest),
    persistentHash(bytes512, fields.params),
    persistentHash(bytes256, fields.outputSchema),
    persistentHash(bytes256, fields.respondSchema),
  ];

  return persistentHash(vec18x32, elements);
}

/**
 * Compute the compound key for a calldata arg in the dynamic array.
 *
 * Matches the Compact circuit:
 *   persistentHash<Vector<2, Bytes<32>>>([requestId, argIndex as Field as Bytes<32>])
 */
export function calldataArgKey(requestId: Uint8Array, argIndex: number): Uint8Array {
  return persistentHash(vec2x32, [
    requestId,
    convertFieldToBytes(32, BigInt(argIndex), 'signet:argIndex'),
  ]);
}

/**
 * Compute the calldata args commitment from an array of Bytes<32> args.
 *
 * Matches the Compact circuit:
 *   persistentHash<Vector<N, Bytes<32>>>(args)
 *
 * The Vector size must match the number of args.
 */
export function computeCalldataArgsCommitment(args: Uint8Array[]): Uint8Array {
  const vecType = new CompactTypeVector(args.length, bytes32);
  return persistentHash(vecType, args);
}

