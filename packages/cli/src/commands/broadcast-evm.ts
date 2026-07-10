// `broadcast-evm` — send an MPC-signed EVM transaction to the EVM chain. The
// MPC only SIGNS; broadcasting is a thin client responsibility.

import { JsonRpcProvider, type Transaction, type TransactionReceipt } from "ethers";

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";

/** Options for {@link broadcastEvm}. */
export interface BroadcastEvmOptions {
  /** The signed EVM transaction to broadcast (e.g. from `poll-signature-response`). */
  readonly transaction: Transaction;
}

/**
 * The "this exact tx was already submitted" family of node errors. Re-POSTing a
 * signed tx the node has already seen is a no-op on-chain (same nonce+signature
 * ⇒ same hash ⇒ one transaction), so these are safe to swallow and fall through
 * to waiting on the hash. Distinct from a *reverted* tx, which mines and gets a
 * receipt with `status: 0`.
 */
function isAlreadySubmitted(err: unknown): boolean {
  // ethers surfaces "nonce too low" as NONCE_EXPIRED; "already known" /
  // "already imported" / "txpool is full"-style dupes come through as the raw
  // node message, so match on text too.
  const code = (err as { code?: string })?.code;
  if (code === "NONCE_EXPIRED") return true;
  const message = ((err as { message?: string })?.message ?? "").toLowerCase();
  return (
    message.includes("already known") ||
    message.includes("already imported") ||
    message.includes("alreadyknown") ||
    message.includes("nonce too low")
  );
}

/**
 * Broadcast a signed EVM transaction to `EVM_RPC_URL` and wait for one
 * confirmation. **Idempotent**: safe to call repeatedly with the same signed
 * transaction.
 *
 * A signed EVM tx is content-addressed — its hash is a pure function of its
 * bytes (nonce + fields + signature) — so the protocol guarantees it can only
 * ever mine once. This function leans on that: it derives the hash locally,
 * short-circuits if the tx has already mined (whether it succeeded OR reverted),
 * and tolerates the node reporting the tx as already-submitted on a re-run.
 *
 * The one case it cannot make idempotent is a *burned nonce*: if the account's
 * nonce has advanced past this tx but this tx never mined, some other
 * transaction took the slot and this one can never land. That is surfaced as an
 * error rather than hung on.
 *
 * @param context - The CLI context.
 * @param options - The transaction to broadcast.
 * @returns The EVM transaction hash.
 * @throws Error when `EVM_RPC_URL` is unset, the transaction reverted on-chain,
 *   or its nonce was consumed by a different transaction (so it can never mine).
 */
export async function broadcastEvm(context: CliContext, options: BroadcastEvmOptions): Promise<string> {
  const evmRpcUrl = requireConfigValue(context.config.evmRpcUrl, "EVM_RPC_URL");
  const provider = new JsonRpcProvider(evmRpcUrl);

  // The hash and sender are already borne by the signed transaction — no
  // parsing or network needed. They are only null if the tx is unsigned.
  const { hash, from, nonce } = options.transaction;
  if (hash === null || from === null) {
    throw new Error("transaction is missing a signature (cannot derive hash/sender)");
  }

  console.log(`evm rpc:   ${evmRpcUrl}`);
  console.log(`tx hash:   ${hash} (nonce ${nonce})`);

  // 1. Already mined? A receipt exists whether the tx succeeded OR reverted —
  //    both consume the nonce, so there is nothing left to broadcast either way.
  const mined = await provider.getTransactionReceipt(hash);
  if (mined !== null) {
    console.log(`already mined at block ${mined.blockNumber}`);
    return assertMinedOk(mined, hash);
  }

  // 2. Broadcast. If the node has already seen this exact tx, that's a no-op —
  //    swallow it and fall through to waiting on the hash.
  try {
    await provider.broadcastTransaction(options.transaction.serialized);
    console.log(`broadcast: ${hash} — waiting for 1 confirmation…`);
  } catch (err) {
    if (!isAlreadySubmitted(err)) throw err;
    console.log(`already submitted — waiting for 1 confirmation…`);
  }

  // 3. Wait for OUR hash to confirm, but bail if the account nonce advances past
  //    this tx without it mining: that means a *different* tx took the slot and
  //    this one can never land, so waiting on the hash would hang forever.
  for (;;) {
    let receipt: TransactionReceipt | null;
    try {
      receipt = await provider.waitForTransaction(hash, 1, 15_000);
    } catch (err) {
      // ethers v6 REJECTS with a TIMEOUT error when the wait window elapses (it
      // does NOT resolve to null) — a confirmation slower than the window is
      // normal on a live chain, so treat it as "not yet" and fall through to
      // the burned-nonce check below, then keep waiting. Any other error is real.
      if ((err as { code?: string })?.code !== "TIMEOUT") throw err;
      receipt = null;
    }
    if (receipt !== null) {
      console.log(`confirmed: ${hash}`);
      return assertMinedOk(receipt, hash);
    }
    const latestNonce = await provider.getTransactionCount(from, "latest");
    if (latestNonce > nonce) {
      // The nonce advanced: either OUR tx just mined (waitForTransaction can
      // miss an inclusion that lands right at its window edge) or a different
      // tx took the slot. Only the receipt distinguishes the two.
      const latestReceipt = await provider.getTransactionReceipt(hash);
      if (latestReceipt !== null) {
        console.log(`confirmed: ${hash}`);
        return assertMinedOk(latestReceipt, hash);
      }
      throw new Error(
        `nonce ${nonce} for ${from} was consumed by a different transaction; ` +
          `this signed tx (${hash}) can never mine`,
      );
    }
    console.log(`still pending (account nonce ${latestNonce}) — waiting…`);
  }
}

/**
 * A mined receipt with `status: 0` means the tx was included but its execution
 * reverted (nonce consumed, gas burned, state rolled back). Treat that as a
 * failure rather than silently returning the hash of a reverted tx.
 */
function assertMinedOk(receipt: TransactionReceipt, hash: string): string {
  if (receipt.status === 0) {
    throw new Error(`transaction ${hash} reverted on-chain (mined in block ${receipt.blockNumber}, status 0)`);
  }
  return hash;
}
