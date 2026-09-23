// The signet request id computation: the TS twin of Signet.compact's
// `calculateRequestId` circuit (see the deviation note in
// signet-requests.ts). Chain-agnostic entry point that resolves each
// record's tx-params descriptor by its `txParamType` tag, so every
// decomposition mints ids through this one function.

import { transientHash, upgradeFromTransient } from "@midnight-ntwrk/compact-runtime";

import { evmType2TxParamsDescriptorOf } from "./signet-evtype2tx-requests.ts";
import {
  type RequestId,
  type RequestIdPreimage,
  requestIdPreimageDescriptorWith,
  type SignBidirectionalEvent,
  TxParamType,
} from "./signet-requests.ts";

/**
 * Canonical id of a signet request: the transientHash (Poseidon) of the
 * record's {@link RequestIdPreimage} (every field except the serialisation
 * schemas) over its field-aligned representation.
 *
 * @param request - The full event record (contract-shaped, all slots).
 * @returns The 32-byte request id, the record's ledger map key.
 * @throws {Error} If the record's `txParamType` names a decomposition this
 *   computation has no descriptor for.
 */
export function calculateRequestId(request: SignBidirectionalEvent): RequestId {
  if (request.txParamType !== TxParamType.evmType2) {
    throw new Error(
      `unsupported txParamType ${String(request.txParamType)}: this id computation ` +
        `understands evmType2 (${String(TxParamType.evmType2)})`,
    );
  }
  const preimage: RequestIdPreimage = {
    sender: request.sender,
    keyVersion: request.keyVersion,
    path: request.path,
    algo: request.algo,
    txParamType: request.txParamType,
    txParams: request.txParams,
    executionDest: request.executionDest,
  };
  return upgradeFromTransient(
    transientHash(
      requestIdPreimageDescriptorWith(evmType2TxParamsDescriptorOf(request.txParams)),
      preimage,
    ),
  );
}
