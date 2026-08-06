// The signet request id computation: the TS twin of Signet.compact's
// `calculateRequestId` circuit (see the deviation note in
// signet-requests.ts). Chain-agnostic entry point that resolves each
// record's tx-params descriptor by its `txParamType` tag, so every
// decomposition mints ids through this one function.

import { keccak256 } from "@midnight-ntwrk/compact-runtime";

import { evmType2TxParamsDescriptorOf } from "./signet-evtype2tx-requests.ts";
import {
  signBidirectionalEventDescriptorWith,
  TxParamType,
  type RequestId,
  type SignBidirectionalEvent,
} from "./signet-requests.ts";

/**
 * Canonical id of a signet request: the keccak256 of the entire event
 * record, the sender address included, with no extra domain tag. Pass the
 * record exactly as the ledger stores it, unused slots included and schemas
 * at their declared widths.
 *
 * @param request - The full event record (contract-shaped, all slots).
 * @returns The 32-byte request id, the record's ledger map key.
 * @throws Error if the record's `txParamType` names a decomposition this
 *   computation has no descriptor for.
 */
export function calculateRequestId(request: SignBidirectionalEvent): RequestId {
  if (request.txParamType !== TxParamType.evmType2) {
    throw new Error(
      `unsupported txParamType ${request.txParamType}: this id computation ` +
        `understands evmType2 (${TxParamType.evmType2})`,
    );
  }
  return keccak256(
    signBidirectionalEventDescriptorWith(
      evmType2TxParamsDescriptorOf(request.txParams),
      request.outputDeserializationSchema.length,
      request.respondSerializationSchema.length,
    ),
    request,
  );
}
