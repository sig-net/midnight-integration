// `withdraw-e2e` — the full withdraw orchestration a UI would run, composed
// from the granular commands. Every MPC hand-off is polled from the
// signet contract.

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";
import { broadcastEvm } from "./broadcast-evm.ts";
import { completeWithdraw } from "./complete-withdraw.ts";
import { pollRespondBidirectional } from "./poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "./poll-signature-response.ts";
import { withdraw } from "./withdraw.ts";

/** Options for {@link withdrawE2E}. */
export interface WithdrawE2EOptions {
  /** Withdraw amount in ERC20 base units. */
  readonly amount: bigint;
  /** Destination EVM address (20-byte 0x hex) receiving the ERC20. */
  readonly destEvmAddress: string;
  /** Nonce of the VAULT's derived EVM account (the withdraw tx sender). */
  readonly evmNonce: bigint;
  /** Poll interval in milliseconds. */
  readonly intervalMs: number;
  /** Give-up timeout in milliseconds per polling stage. */
  readonly timeoutMs: number;
}

/**
 * Run the withdraw flow end-to-end:
 * 1. `withdraw` surrenders the shielded coin and records the signature
 *    request (`path = "vault"`).
 * 2. The MPC signs the vault→destination EVM transfer and posts the signed
 *    transaction to the signet contract; poll for it.
 * 3. Broadcast the signed transaction to the EVM chain.
 * 4. The MPC observes the receipt and posts the Schnorr-signed
 *    `(requestId, serializedOutput)` attestation; poll for it.
 * 5. `completeWithdraw` settles the request: success is final, failure
 *    re-mints the surrendered value to the withdrawer (this wallet).
 *
 * @param context - The CLI context.
 * @param options - The withdraw arguments and polling patience.
 */
export async function withdrawE2E(context: CliContext, options: WithdrawE2EOptions): Promise<void> {
  const { amount, destEvmAddress, evmNonce, intervalMs, timeoutMs } = options;

  const requestId = await withdraw(context, { amount, destEvmAddress, evmNonce });

  // Withdraw transactions are signed by the VAULT's derived account, not the
  // user's — verify the MPC's signature against it.
  const expectedSigner = requireConfigValue(context.config.evmVaultAddress, "EVM_VAULT_ADDRESS");
  const transaction = await pollSignatureResponse(context, { requestId, intervalMs, timeoutMs, expectedSigner });
  await broadcastEvm(context, { transaction });

  await pollRespondBidirectional(context, { requestId, intervalMs, timeoutMs });
  await completeWithdraw(context, { requestId });

  console.log(`withdraw ${requestId} settled`);
}
