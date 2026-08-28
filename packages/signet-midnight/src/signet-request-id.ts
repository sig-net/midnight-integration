// The signet request id computation: the TS twin of Signet.compact's
// `calculateRequestId` circuit (see the deviation note in
// signet-requests.ts). Chain-agnostic entry point that resolves each
// record's tx-params descriptor by its `txParamType` tag, so every
// decomposition mints ids through this one function.

import { transientHash, upgradeFromTransient } from "@midnight-ntwrk/compact-runtime";

import { evmType2TxParamsDescriptorOf } from "./signet-evtype2tx-requests.ts";
import {
  type RequestId,
  type SignBidirectionalEvent,
  signBidirectionalEventDescriptorWith,
  TxParamType,
} from "./signet-requests.ts";

/**
 * Canonical id of a signet request: the transientHash (Poseidon) of the
 * entire event record over its field-aligned representation, the sender
 * address included, with no extra domain tag, upgraded to 32 bytes. Pass the
 * record exactly as the ledger stores it, unused slots included and schemas
 * at their declared widths.
 *
 * Byte 31 of the id is always zero: `upgradeFromTransient` stores the field
 * element in the low 31 bytes.
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
  return upgradeFromTransient(
    transientHash(
      signBidirectionalEventDescriptorWith(
        evmType2TxParamsDescriptorOf(request.txParams),
        request.outputDeserializationSchema.length,
        request.respondSerializationSchema.length,
      ),
      request,
    ),
  );
}
