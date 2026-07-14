// `poll-signature-response` — stage 1 of the MPC round trip: poll the central
// signet contract's signature response log by request id until the MPC's
// ECDSA signature over a request's EVM transaction appears, verifying every
// post on the way. There is deliberately no push/websocket alternative.

import type { Transaction } from "ethers";

import {
  SignetRequestResponseReader,
  signBidirectionalRequestToSignedEVMTransaction,
  sleepUnlessAborted,
  type RequestIdHex,
} from "@sig-net/midnight";

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";

/** Options for {@link pollSignatureResponse}. */
export interface PollSignatureResponseOptions {
  /** The request id to poll for. */
  readonly requestId: RequestIdHex;
  /** Poll interval in milliseconds. */
  readonly intervalMs: number;
  /** Give-up timeout in milliseconds. */
  readonly timeoutMs: number;
  /**
   * EVM address the MPC's signature must recover to — the request's derived
   * sender. Deposit requests are signed by the user's derived account
   * (`EVM_USER_ADDRESS`); withdraw requests by the VAULT's
   * (`EVM_VAULT_ADDRESS`). Always explicit: this command is generic over
   * request kinds, and which account signs is the caller's knowledge.
   */
  readonly expectedSigner: string;
}

/**
 * Poll the signet contract at `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` until a
 * VALID signature response for `requestId` appears in its response log, then
 * reconstruct and return the fully signed EVM transaction as a typed ethers
 * {@link Transaction}, ready to hand straight to `broadcast-evm`. Serialize
 * it (`.serialized`) only at the edge — for stdout or
 * `eth_sendRawTransaction`.
 *
 * Enumeration and verification are delegated to signet-midnight's
 * {@link SignetRequestResponseReader}: each tick reads the response log at
 * `requestId` and — the log being unauthenticated (secp256k1 cannot be
 * verified in-circuit) — judges every post by whether its signature recovers
 * to the request's MPC-derived sender (see
 * {@link PollSignatureResponseOptions.expectedSigner}) over the requested
 * transaction's signing hash. The first valid post wins. The signed
 * transaction is assembled from the request record and that response via
 * {@link signBidirectionalRequestToSignedEVMTransaction}. This command owns
 * the poll loop, the timeout, and the reporting — each rejected post is
 * warned once across the loop's lifetime, not every tick. For the MPC's
 * attestation of the EVM result, see `poll-respond-bidirectional`.
 *
 * @param context - The CLI context.
 * @param options - What to poll for and how patiently.
 * @returns The broadcast-ready signed EVM transaction.
 * @throws Error when a contract has no state on-chain, the request is not on
 *   the vault's ledger, the responses ledger is inconsistent, or `timeoutMs`
 *   elapses with no valid response posted.
 */
export async function pollSignatureResponse(context: CliContext, options: PollSignatureResponseOptions): Promise<Transaction> {
  const signetContractAddress = requireConfigValue(
    context.config.signetContractAddress,
    "MIDNIGHT_SIGNET_CONTRACT_ADDRESS",
  );
  const vaultContractAddress = requireConfigValue(
    context.config.vaultContractAddress,
    "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
  );
  const expectedSigner = options.expectedSigner;
  console.log(`signet contract:   ${signetContractAddress}`);
  console.log(`request id:         ${options.requestId}`);
  console.log(`expected signer:    ${expectedSigner}`);
  console.log(`poll:               every ${options.intervalMs}ms, up to ${options.timeoutMs}ms`);

  const reader = new SignetRequestResponseReader({
    requesterContractAddress: vaultContractAddress,
    signetContractAddress,
    publicDataProvider: context.midnightProviders.indexerPublicDataProvider,
  });

  // The reader is single-shot; this loop owns the cadence and the give-up
  // timeout. Rejected posts are immutable log entries, so warn each count
  // once across the loop's lifetime, not every tick.
  const warned = new Set<bigint>();
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), options.timeoutMs);
  try {
    while (!giveUp.signal.aborted) {
      const { verified, verdicts } = await reader.getVerifiedSignatureResponse(
        options.requestId,
        expectedSigner,
      );
      for (const verdict of verdicts) {
        if (verdict.rejectedReason !== undefined && !warned.has(verdict.count)) {
          warned.add(verdict.count);
          console.warn(`ignoring response post ${verdict.count}: ${verdict.rejectedReason}`);
        }
      }
      if (verified !== undefined) {
        const validCount = verdicts.find(
          (verdict) => verdict.rejectedReason === undefined,
        )?.count;
        console.log(`valid response found (post ${validCount})`);
        // Reconstruct the broadcast-ready signed transaction from the request
        // record and this response. The reader's request fetch is cached (its
        // verification already fetched it), so this adds no extra query.
        const request = await reader.getSignatureRequest(options.requestId);
        return signBidirectionalRequestToSignedEVMTransaction(request, verified);
      }
      await sleepUnlessAborted(options.intervalMs, giveUp.signal);
    }
    throw new Error(
      `timed out after ${options.timeoutMs}ms waiting for a valid response to request ${options.requestId}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
