// `withdraw-e2e` — the full withdraw orchestration a UI would run, composed
// from the granular commands. Every MPC hand-off is polled from the
// signet contract.

import type { CliContext } from "../context.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { pollRespondBidirectional } from "./poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";
import { refundWithdraw } from "./refund-withdraw.ts";
import { requestWithdraw } from "./request-withdraw.ts";

/** Options for {@link withdrawE2E}. */
export interface WithdrawE2EOptions {
  /** Withdraw amount in ERC20 base units. */
  readonly amount: bigint;
  /** Destination EVM address (20-byte 0x hex) receiving the ERC20. */
  readonly destEvmAddress: string;
  /** Poll interval in milliseconds. */
  readonly intervalMs: number;
  /** Give-up timeout in milliseconds per polling stage. */
  readonly timeoutMs: number;
}

/**
 * Run the withdraw flow end-to-end:
 * 1. `requestWithdraw` escrows the shielded coin and records the signature
 *    request (`path = "vault"`).
 * 2. The MPC signs the vault→destination EVM transfer and posts the signed
 *    transaction to the signet contract; poll for it.
 * 3. Broadcast the signed transaction to the EVM chain.
 * 4. The MPC observes the receipt and posts the Schnorr-signed
 *    `(requestId, serializedOutput)` attestation; poll for it.
 * 5. `refundWithdraw` settles the request: success is final, failure
 *    re-mints the escrow to the pinned refund recipient.
 *
 * Currently halts at step 1 (circuit not ported).
 *
 * @param context - The CLI context.
 * @param options - The withdraw arguments and polling patience.
 * @throws NotImplementedError — from the first unwired step.
 */
export async function withdrawE2E(context: CliContext, options: WithdrawE2EOptions): Promise<void> {
  const { amount, destEvmAddress, intervalMs, timeoutMs } = options;

  const requestId = await requestWithdraw(context, { amount, destEvmAddress });

  const transaction = await pollSignatureResponse(context, { requestId, intervalMs, timeoutMs });
  await broadcastEvm(context, { transaction });

  await pollRespondBidirectional(context, { requestId, intervalMs, timeoutMs });
  await refundWithdraw(context, { requestId });

  console.log(`withdraw ${requestId} settled`);
}
