// The signet request id computation: the TS twin of Signet.compact's
// `calculateEvmType2RequestIdV1` circuit (see the deviation note in
// signet-requests.ts). Chain-agnostic entry point that digests each record's
// transaction by its `txParamType` tag, so every decomposition mints ids
// through this one function.

import { transientHash, upgradeFromTransient } from "@midnight-ntwrk/compact-runtime";

import { calculateEvmType2TxParamsDigest } from "./signet-evtype2tx-requests.ts";
import {
  type RequestId,
  type RequestIdPreimage,
  requestIdPreimageDescriptor,
  type SignBidirectionalEvent,
  TxParamType,
} from "./signet-requests.ts";

/**
 * Canonical id of a signet request: the transientHash (Poseidon) of the
 * record's {@link RequestIdPreimage} over its field-aligned representation,
 * with the transaction entering as its decomposition's digest
 * ({@link calculateEvmType2TxParamsDigest} for evmType2), so the id ignores
 * the record's capacities and unused slots.
 *
 * @param request - The full event record (contract-shaped, all slots).
 * @returns The 32-byte request id, the record's ledger map key.
 * @throws {Error} If the record's `txParamType` names a decomposition this
 *   computation has no digest for, or a count overruns its capacity.
 */
export function calculateRequestId(request: SignBidirectionalEvent): RequestId {
  if (request.txParamType !== TxParamType.evmType2) {
    throw new Error(
      `unsupported txParamType ${String(request.txParamType)}: this id computation ` +
        `understands evmType2 (${String(TxParamType.evmType2)})`,
    );
  }
  const preimage: RequestIdPreimage = {
    keyVersion: request.keyVersion,
    sender: request.sender,
    path: request.path,
    algo: request.algo,
    txParamType: request.txParamType,
    txParamsDigest: calculateEvmType2TxParamsDigest(request.txParams),
    executionDest: request.executionDest,
  };
  return upgradeFromTransient(transientHash(requestIdPreimageDescriptor, preimage));
}
