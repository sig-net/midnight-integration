// `deposit-e2e` — the full deposit orchestration a UI would run, composed
// from the granular commands. Every MPC hand-off is polled from the
// signet contract.

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { claim } from "./claim.ts";
import { pollRespondBidirectional } from "./poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";
import { deposit } from "./deposit.ts";

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
 * 1. `deposit` records the signature request on the vault's ledger.
 * 2. The MPC (watching the vault via the indexer) signs the EVM sweep and
 *    posts the signed transaction to the signet contract;
 *    poll for it.
 * 3. Broadcast the signed transaction to the EVM chain.
 * 4. The MPC observes the receipt and posts the Schnorr-signed
 *    `(requestId, serializedOutput)` attestation; poll for it.
 * 5. `claim` verifies the attestation in-circuit and mints shielded vault
 *    tokens.
 *
 * @param context - The CLI context.
 * @param options - The deposit arguments and polling patience.
 */
export async function depositE2E(context: CliContext, options: DepositE2EOptions): Promise<void> {
  const { amount, evmNonce, intervalMs, timeoutMs } = options;

  const requestId = await deposit(context, { amount, evmNonce });

  // Deposit sweeps are signed by the USER's derived account — verify the
  // MPC's signature against it.
  const expectedSigner = requireConfigValue(context.config.evmUserAddress, "EVM_USER_ADDRESS");
  const transaction = await pollSignatureResponse(context, { requestId, intervalMs, timeoutMs, expectedSigner });
  await broadcastEvm(context, { transaction });

  await pollRespondBidirectional(context, { requestId, intervalMs, timeoutMs });
  await claim(context, { requestId });

  console.log(`deposit ${requestId} claimed`);
}
