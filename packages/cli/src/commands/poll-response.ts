// `poll-response` — the ONLY channel by which MPC output reaches a client:
// poll the signature-responses contract for the record keyed by a request id.
// There is deliberately no push/websocket alternative.

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";
import { NotImplementedError } from "../errors.ts";

/** Options for {@link pollResponse}. */
export interface PollResponseOptions {
  /** The request id to poll for (64-char hex). */
  readonly requestId: string;
  /** Poll interval in milliseconds. */
  readonly intervalMs: number;
  /** Give-up timeout in milliseconds. */
  readonly timeoutMs: number;
}

/**
 * Poll the signature-responses contract at `RESPONSES_CONTRACT_ADDRESS` until
 * a response for `requestId` appears, and return its payload as hex.
 *
 * Wired behavior: repeatedly query the contract's raw state through the
 * context's public-data provider and decode the field-0 response map. The MPC
 * posts two kinds of payload per request over the flow's lifetime: first the
 * signed EVM transaction (for the client to broadcast), later the
 * Schnorr-signed `(requestId, outputData)` attestation of the EVM result.
 *
 * @param context - The CLI context.
 * @param options - What to poll for and how patiently.
 * @returns The response payload as hex.
 * @throws NotImplementedError — the deployed responses contract currently
 * stores a placeholder 32-byte record that cannot carry either payload; the
 * real response record is still to be designed.
 */
export async function pollResponse(context: CliContext, options: PollResponseOptions): Promise<string> {
  const responsesContractAddress = requireConfigValue(
    context.config.responsesContractAddress,
    "RESPONSES_CONTRACT_ADDRESS",
  );
  console.log(`responses contract: ${responsesContractAddress}`);
  console.log(`request id:         ${options.requestId}`);
  console.log(`poll:               every ${options.intervalMs}ms, up to ${options.timeoutMs}ms`);

  await context.publicDataProvider();
  throw new NotImplementedError(
    "poll-response cannot decode a response yet: the signature-responses contract stores a placeholder " +
      "32-byte record that cannot carry a signed EVM transaction or a Schnorr attestation",
  );
}
