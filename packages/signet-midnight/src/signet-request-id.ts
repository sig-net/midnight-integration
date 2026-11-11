// The signet request id computation: the TS twin of Signet.compact's
// `calculateEvmType2RequestIdV1` and `calculateTronRequestIdV1` circuits (see
// the deviation note in signet-requests.ts). Chain-agnostic entry point that digests each record's
// transaction by its `txParamType` tag, so every decomposition mints ids
// through this one function.

import { transientHash, upgradeFromTransient } from "@midnight-ntwrk/compact-runtime";

import { compactTupleDescriptor, HASH_DOMAIN } from "./compact-descriptors.ts";
import { HashDomain } from "./managed/contract/index.js";
import { calculateEvmType2TxParamsDigest } from "./signet-evtype2tx-requests.ts";
import {
  type AnySignBidirectionalEvent,
  isEvmType2SignBidirectionalEvent,
  isTronSignBidirectionalEvent,
  type RequestId,
  type RequestIdPreimage,
  requestIdPreimageDescriptor,
  TxParamType,
} from "./signet-requests.ts";
import { calculateTronTxParamsDigest } from "./signet-tron-requests.ts";

const REQUEST_ID_HASH_PREIMAGE = compactTupleDescriptor<[HashDomain, RequestIdPreimage]>([
  HASH_DOMAIN,
  requestIdPreimageDescriptor,
]);

/**
 * Canonical id of a signet request: the transientHash (Poseidon) of the
 * record's {@link RequestIdPreimage} prefixed with {@link HashDomain.requestId},
 * with the transaction entering as its decomposition's digest
 * ({@link calculateEvmType2TxParamsDigest} for evmType2,
 * {@link calculateTronTxParamsDigest} for tron), so the id ignores the
 * record's capacities and unused slots.
 *
 * @param request - The full event record (contract-shaped, all slots).
 * @returns The 32-byte request id, the record's ledger map key.
 * @throws {Error} If the record's `txParamType` names a decomposition this
 *   computation has no digest for, or a count overruns its capacity.
 */
export function calculateRequestId(request: AnySignBidirectionalEvent): RequestId {
  const { txParamType } = request;
  let txParamsDigest: Uint8Array;
  if (isEvmType2SignBidirectionalEvent(request)) {
    txParamsDigest = calculateEvmType2TxParamsDigest(request.txParams);
  } else if (isTronSignBidirectionalEvent(request)) {
    txParamsDigest = calculateTronTxParamsDigest(request.txParams);
  } else {
    throw new Error(
      `unsupported txParamType ${String(txParamType)}: this id computation ` +
        `understands evmType2 (${String(TxParamType.evmType2)}) and tron ` +
        `(${String(TxParamType.tron)})`,
    );
  }
  const preimage: RequestIdPreimage = {
    keyVersion: request.keyVersion,
    sender: request.sender,
    path: request.path,
    algo: request.algo,
    txParamType,
    txParamsDigest,
    executionDest: request.executionDest,
  };
  return upgradeFromTransient(
    transientHash(REQUEST_ID_HASH_PREIMAGE, [HashDomain.requestId, preimage]),
  );
}
