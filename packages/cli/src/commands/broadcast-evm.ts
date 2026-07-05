// `broadcast-evm` — send an MPC-signed EVM transaction to the EVM chain. The
// MPC only SIGNS; broadcasting is a thin client responsibility.

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";
import { NotImplementedError } from "../errors.ts";

/** Options for {@link broadcastEvm}. */
export interface BroadcastEvmOptions {
  /** The signed, RLP-encoded EVM transaction as 0x hex. */
  readonly signedTransaction: string;
}

/**
 * Broadcast a signed EVM transaction to `EVM_RPC_URL` and wait for its
 * receipt.
 *
 * Wired behavior: `ethers.JsonRpcProvider.broadcastTransaction` followed by
 * waiting for one confirmation; returns the transaction hash. (The ethers
 * dependency is added when this is wired.)
 *
 * @param context - The CLI context.
 * @param options - The transaction to broadcast.
 * @returns The EVM transaction hash.
 * @throws NotImplementedError — EVM broadcasting is not wired yet.
 */
export async function broadcastEvm(context: CliContext, options: BroadcastEvmOptions): Promise<string> {
  const evmRpcUrl = requireConfigValue(context.config.evmRpcUrl, "EVM_RPC_URL");
  console.log(`evm rpc:   ${evmRpcUrl}`);
  console.log(`signed tx: ${options.signedTransaction.slice(0, 34)}…`);
  throw new NotImplementedError("broadcast-evm is not wired yet (the ethers dependency lands with it)");
}
