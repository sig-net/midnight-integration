// The whole deposit leg as one arrange-stage helper: request → MPC signature
// → EVM sweep broadcast → MPC attestation → claim. Flow files that need the
// caller to HOLD shielded vault tokens (failure-refund, benchmark…) run this
// first; the happy-day file deliberately does NOT use it — its long-hand
// steps carry the per-leg assertions (golden events, MPC-style ledger reads)
// this helper elides. Per AGENTS.md, this file only SEQUENCES exported cli
// commands plus plain reads — every orchestration primitive lives in the cli.

import {
  broadcastEvm,
  claimDeposit,
  pollSignatureResponse,
  pollRespondBidirectional,
  requestDeposit,
  requireConfigValue,
  readVaultLedger,
  type ShieldedTokenRecipient,
} from "@midnight-erc20-vault/cli";
import {
  executionSucceeded,
  requestIdBytes,
  type RequestIdHex,
} from "@midnight-erc20-vault/signet-midnight";
import { requireEnv } from "../e2e-env.ts";
import { getTransactionNonce } from "../evm.ts";
import { logSkip } from "../output.ts";
import type { E2eSession } from "../session.ts";

const MINUTE = 60_000;

/** Options for {@link runDepositRoundTrip}. */
export interface DepositRoundTripOptions {
  /** Deposit amount in ERC20 base units. */
  readonly amount: bigint;
  /**
   * Resume from an existing request instead of calling `requestDeposit` —
   * for recovering a run that died mid-round-trip (e.g. the proof server
   * OOM-killed at the claim step). Every later leg is naturally idempotent:
   * the signature response and attestation persist on the signet ledger,
   * `broadcastEvm` short-circuits on a mined sweep, and an already-claimed
   * request skips the claim.
   */
  readonly reuseRequestId?: RequestIdHex;
  /**
   * The wallet the claim mints the shielded vault tokens to; the caller's
   * own wallet when omitted. Passed through to `claimDeposit` — only the
   * depositor (the session wallet) may claim either way.
   */
  readonly claimRecipient?: ShieldedTokenRecipient;
}

/** What {@link runDepositRoundTrip} hands back to the flow file. */
export interface DepositRoundTripResult {
  /** The deposit request id the round trip created (or resumed). */
  readonly requestId: RequestIdHex;
  /** Wall-clock milliseconds per leg, keyed by cli command name. */
  readonly timings: Record<string, number>;
  /**
   * Whether THIS run executed the claim. `false` means the request was
   * already claimed by a prior run (rerun against a kept contract address) —
   * the mint happened back then, so effects like a balance delta are not
   * observable in this run.
   */
  readonly claimed: boolean;
}

/**
 * Run the full deposit round trip against the live stack: fetch the user's
 * EVM nonce, `requestDeposit`, poll the MPC's signature, broadcast the sweep,
 * poll the MPC's attestation, and `claimDeposit` — leaving the claim
 * recipient (`opts.claimRecipient`, the caller's own wallet by default)
 * holding `opts.amount` of freshly minted shielded vault tokens.
 *
 * Arrange-stage plumbing: it asserts each leg produced what the next one
 * needs (pointed throws, nothing skips silently), but carries none of the
 * golden-event assertions the happy-day file owns. Rerun-tolerant against
 * kept addresses: an already-claimed request logs a skip instead of failing.
 *
 * @param session - The flow file's shared session (wallet + cli context).
 * @param env - The setup-populated env accumulator.
 * @param opts - Deposit amount and optional resume id.
 * @returns The request id and per-leg wall-clock timings.
 * @throws If any leg times out, the MPC attests the sweep as failed, or the
 *   sweep transaction reverts on-chain.
 */
export async function runDepositRoundTrip(
  session: E2eSession,
  env: NodeJS.ProcessEnv,
  opts: DepositRoundTripOptions,
): Promise<DepositRoundTripResult> {
  const context = await session.cliContext();
  const timings: Record<string, number> = {};
  const timed = async <T>(leg: string, run: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await run();
    } finally {
      timings[leg] = Date.now() - startedAt;
    }
  };

  let requestId: RequestIdHex;
  if (opts.reuseRequestId) {
    requestId = opts.reuseRequestId;
    logSkip("requestDeposit", `resuming deposit round trip from existing request ${requestId}`);
  } else {
    // The sweep tx sender is the user's derived EVM account; its next nonce
    // comes from the chain, exactly as a wallet would fetch it.
    const evmNonce = await getTransactionNonce(
      requireEnv(env, "EVM_RPC_URL"),
      requireEnv(env, "EVM_USER_ADDRESS"),
    );
    requestId = await timed("requestDeposit", () =>
      requestDeposit(context, { amount: opts.amount, evmNonce }),
    );
  }
  if (!/^[0-9a-f]{64}$/.test(requestId)) {
    throw new Error(`deposit request id is not 64-char lowercase hex: "${requestId}"`);
  }

  // Deposit sweeps are signed by the USER's derived account.
  const signedSweepTransaction = await timed("pollSignatureResponse", () =>
    pollSignatureResponse(context, {
      requestId,
      intervalMs: 1000,
      timeoutMs: 2 * MINUTE,
      expectedSigner: requireEnv(env, "EVM_USER_ADDRESS"),
    }),
  );

  // Idempotent: an already-mined sweep short-circuits; a reverted or
  // nonce-burned sweep throws — either would starve the claim, so let it.
  await timed("broadcastEvm", () =>
    broadcastEvm(context, { transaction: signedSweepTransaction }),
  );

  const attestation = await timed("pollRespondBidirectional", () =>
    pollRespondBidirectional(context, {
      requestId,
      intervalMs: 1000,
      timeoutMs: 2 * MINUTE,
    }),
  );
  // This helper arranges a SUCCESSFUL deposit — a failure attestation means
  // the sweep did not land and the claim below could never mint.
  if (!executionSucceeded(attestation.serializedOutput)) {
    throw new Error(
      `the MPC attested deposit sweep ${requestId} as FAILED — ` +
        `the sweep broadcast above mined, so the responder saw a different outcome (stale responder config?)`,
    );
  }

  // Rerun against a kept contract address: a prior run may have already
  // claimed this request (claiming consumes it from the ledger) — the minted
  // tokens are already in the wallet, so skip instead of failing.
  const vaultContractAddress = requireConfigValue(
    context.config.vaultContractAddress,
    "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
  );
  const ledger = await readVaultLedger(context, vaultContractAddress);
  let claimed = false;
  if (!ledger.signetRequestsIndex.member(requestIdBytes(requestId))) {
    logSkip("claimDeposit", `request ${requestId} already claimed (not on the ledger)`);
  } else {
    await timed("claimDeposit", () =>
      claimDeposit(context, { requestId, recipient: opts.claimRecipient }),
    );
    claimed = true;
  }

  return { requestId, timings, claimed };
}
