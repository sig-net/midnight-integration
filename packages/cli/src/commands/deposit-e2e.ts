// `deposit-e2e` — the full deposit orchestration a UI would run, composed
// from the granular commands. Every MPC hand-off is polled from the
// signet contract.

import type { CliContext } from "../context.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { claimDeposit } from "./claim-deposit.ts";
import { pollRespondBidirectional } from "./poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";
import { requestDeposit } from "./request-deposit.ts";

/** Options for {@link depositE2E}. */
export interface DepositE2EOptions {
  /** Deposit amount in ERC20 base units. */
  readonly amount: bigint;
  /** Nonce of the user's derived EVM account (the sweep tx sender). */
  readonly evmNonce: bigint;
  /** Poll interval in milliseconds. */
  readonly intervalMs: number;
  /** Give-up timeout in milliseconds per polling stage. */
  readonly timeoutMs: number;
}

/**
 * Run the deposit flow end-to-end:
 * 1. `requestDeposit` records the signature request on the vault's ledger.
 * 2. The MPC (watching the vault via the indexer) signs the EVM sweep and
 *    posts the signed transaction to the signet contract;
 *    poll for it.
 * 3. Broadcast the signed transaction to the EVM chain.
 * 4. The MPC observes the receipt and posts the Schnorr-signed
 *    `(requestId, serializedOutput)` attestation; poll for it.
 * 5. `claimDeposit` verifies the attestation in-circuit and mints shielded
 *    vault tokens.
 *
 * Currently halts at step 1 (call-transaction plumbing pending).
 *
 * @param context - The CLI context.
 * @param options - The deposit arguments and polling patience.
 * @throws NotImplementedError — from the first unwired step.
 */
export async function depositE2E(context: CliContext, options: DepositE2EOptions): Promise<void> {
  const { amount, evmNonce, intervalMs, timeoutMs } = options;

  const requestId = await requestDeposit(context, { amount, evmNonce });

  const transaction = await pollSignatureResponse(context, { requestId, intervalMs, timeoutMs });
  await broadcastEvm(context, { transaction });

  await pollRespondBidirectional(context, { requestId, intervalMs, timeoutMs });
  await claimDeposit(context, { requestId });

  console.log(`deposit ${requestId} claimed`);
}
