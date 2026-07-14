// `poll-respond-bidirectional` — stage 2 of the MPC round trip: poll the
// central signet contract's respond-bidirectional index by request id until
// the MPC's Schnorr-signed attestation of a request's remote EVM execution
// appears, and return the record. There is deliberately no push/websocket
// alternative.

import {
  bytesToHex,
  isExecutionError,
  executionSucceeded,
  SignetRequestResponseReader,
  sleepUnlessAborted,
  type RespondBidirectional,
  type RequestIdHex,
} from "@sig-net/midnight";

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";

/** Options for {@link pollRespondBidirectional}. */
export interface PollRespondBidirectionalOptions {
  /** The request id to poll for. */
  readonly requestId: RequestIdHex;
  /** Poll interval in milliseconds. */
  readonly intervalMs: number;
  /** Give-up timeout in milliseconds. */
  readonly timeoutMs: number;
}

/**
 * Poll the signet contract at `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` until the
 * MPC's respond-bidirectional attestation for `requestId` appears in its
 * respond-bidirectional index, and return it.
 *
 * The read is delegated to signet-midnight's
 * {@link SignetRequestResponseReader.getRespondBidirectional}: each tick
 * reads the single authenticated slot at `requestId`; `undefined` means not
 * posted yet. No off-chain verification happens here — none is needed: the
 * signet contract verified the attestation IN-CIRCUIT at post time (Schnorr
 * over `(requestId, hash(serializedOutput, outputLen))` against its sealed
 * MPC key), so a stored record is authentic by construction. This command
 * owns the poll loop, the timeout, and the reporting: it decodes and logs the
 * outcome (success flag / MPC error sentinel); acting on it (claiming,
 * refunding) is the caller's job.
 *
 * @param context - The CLI context.
 * @param options - What to poll for and how patiently.
 * @returns The attestation record.
 * @throws Error when the contract has no state on-chain or `timeoutMs`
 *   elapses with no attestation posted.
 */
export async function pollRespondBidirectional(
  context: CliContext,
  options: PollRespondBidirectionalOptions,
): Promise<RespondBidirectional> {
  const signetContractAddress = requireConfigValue(
    context.config.signetContractAddress,
    "MIDNIGHT_SIGNET_CONTRACT_ADDRESS",
  );
  const vaultContractAddress = requireConfigValue(
    context.config.vaultContractAddress,
    "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
  );
  console.log(`signet contract:   ${signetContractAddress}`);
  console.log(`request id:        ${options.requestId}`);
  console.log(`poll:              every ${options.intervalMs}ms, up to ${options.timeoutMs}ms`);

  const reader = new SignetRequestResponseReader({
    requesterContractAddress: vaultContractAddress,
    signetContractAddress,
    publicDataProvider: context.midnightProviders.indexerPublicDataProvider,
  });

  // The reader is single-shot; this loop owns the cadence and the give-up
  // timeout.
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), options.timeoutMs);
  try {
    while (!giveUp.signal.aborted) {
      const respondBidirectional = await reader.getRespondBidirectional(
        options.requestId,
      );
      if (respondBidirectional !== undefined) {
        if (isExecutionError(respondBidirectional.serializedOutput)) {
          console.log("remote execution FAILED (MPC error sentinel)");
        } else {
          console.log(`remote execution ${executionSucceeded(respondBidirectional.serializedOutput) ? "succeeded" : "returned false"}`);
        }
        return respondBidirectional;
      }
      await sleepUnlessAborted(options.intervalMs, giveUp.signal);
    }
    throw new Error(
      `timed out after ${options.timeoutMs}ms waiting for a respond-bidirectional attestation to request ${options.requestId}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Render an attestation for CLI output: the serialized output as lowercase
 * hex, no `0x` prefix (the Schnorr components are on-ledger plumbing, not
 * payload).
 *
 * @param respondBidirectional - The attestation record to render.
 * @returns The serialized output hex.
 */
export function formatRespondBidirectional(
  respondBidirectional: RespondBidirectional,
): string {
  return bytesToHex(respondBidirectional.serializedOutput);
}
