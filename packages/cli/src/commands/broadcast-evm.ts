// `broadcast-evm` — send an MPC-signed EVM transaction to the EVM chain. The
// MPC only SIGNS; broadcasting is a thin client responsibility.

import { JsonRpcProvider } from "ethers";

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";

/** Options for {@link broadcastEvm}. */
export interface BroadcastEvmOptions {
  /** The signed, serialized EVM transaction as 0x hex (e.g. from `poll-signature-response`). */
  readonly signedTransaction: string;
}

/**
 * Broadcast a signed EVM transaction to `EVM_RPC_URL` and wait for one
 * confirmation.
 *
 * @param context - The CLI context.
 * @param options - The transaction to broadcast.
 * @returns The EVM transaction hash.
 * @throws Error when `EVM_RPC_URL` is unset, or the node rejects the
 *   transaction (already known, underpriced, nonce too low, reverted, …).
 */
export async function broadcastEvm(context: CliContext, options: BroadcastEvmOptions): Promise<string> {
  const evmRpcUrl = requireConfigValue(context.config.evmRpcUrl, "EVM_RPC_URL");
  console.log(`evm rpc:   ${evmRpcUrl}`);
  console.log(`signed tx: ${options.signedTransaction.slice(0, 34)}…`);

  const provider = new JsonRpcProvider(evmRpcUrl);
  const response = await provider.broadcastTransaction(options.signedTransaction);
  console.log(`broadcast: ${response.hash} — waiting for 1 confirmation…`);
  await response.wait(1);
  console.log(`confirmed: ${response.hash}`);
  return response.hash;
}
