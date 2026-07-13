// `poll-signature-response` — stage 1 of the MPC round trip: watch the
// central signet contract for the SignatureRespondedEvent announcing that the
// MPC posted its ECDSA signature over a request's EVM transaction, then read
// the posted response back and verify it. There is deliberately no
// push/websocket alternative.

import type { Transaction } from "ethers";

import {
  SignetResponseFeed,
  signBidirectionalRequestToSignedEVMTransaction,
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
 * Watch the signet contract at `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` until a
 * VALID signature response for `requestId` appears, then reconstruct and
 * return the fully signed EVM transaction as a typed ethers
 * {@link Transaction}, ready to hand straight to `broadcast-evm`. Serialize
 * it (`.serialized`) only at the edge — for stdout or
 * `eth_sendRawTransaction`.
 *
 * Discovery, enumeration, and verification are delegated to signet-midnight's
 * {@link SignetResponseFeed}: the signet contract emits a
 * SignatureRespondedEvent per post, the feed reads the response log when an
 * event announces a new post, and — the log being unauthenticated (secp256k1
 * cannot be verified in-circuit) — judges every post by whether its signature
 * recovers to the request's MPC-derived sender (see
 * {@link PollSignatureResponseOptions.expectedSigner}) over the requested
 * transaction's signing hash. The first valid post wins. The signed
 * transaction is assembled from the request record and that response via
 * {@link signBidirectionalRequestToSignedEVMTransaction}. This command owns
 * only the timeout and the reporting — the feed yields each post's verdict
 * exactly once, so each rejected post is warned once, not every tick. For the
 * MPC's attestation of the EVM result, see `poll-respond-bidirectional`.
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

  const feed = new SignetResponseFeed({
    requesterContractAddress: vaultContractAddress,
    signetContractAddress,
    source: context.midnightProviders.indexerPublicDataProvider,
    pollIntervalMs: options.intervalMs,
  });

  // The verdict stream only ever ends on abort; the timer turns that into
  // the give-up timeout.
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), options.timeoutMs);
  try {
    for await (const verdict of feed.verdicts(options.requestId, expectedSigner, {
      signal: giveUp.signal,
    })) {
      if (verdict.rejectedReason !== undefined) {
        console.warn(`ignoring response post ${verdict.count}: ${verdict.rejectedReason}`);
        continue;
      }
      console.log(`valid response found (post ${verdict.count})`);
      // Reconstruct the broadcast-ready signed transaction from the request
      // record and this response. The feed's request fetch is cached (its
      // verification already fetched it), so this adds no extra query.
      const request = await feed.getSignatureRequest(options.requestId);
      return signBidirectionalRequestToSignedEVMTransaction(request, verdict.response);
    }
    throw new Error(
      `timed out after ${options.timeoutMs}ms waiting for a valid response to request ${options.requestId}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
