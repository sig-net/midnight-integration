// `poll-response` — the ONLY channel by which MPC output reaches a client:
// poll the signature-responses contract for the record keyed by a request id.
// There is deliberately no push/websocket alternative.

import {
  bytesToHex,
  SignetRequestResponseReader,
  type SignetRequestIdHex,
} from "@midnight-erc20-vault/signet-midnight";

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";

/** Options for {@link pollResponse}. */
export interface PollResponseOptions {
  /** The request id to poll for. */
  readonly requestId: SignetRequestIdHex;
  /** Poll interval in milliseconds. */
  readonly intervalMs: number;
  /** Give-up timeout in milliseconds. */
  readonly timeoutMs: number;
}

/** Resolve after `ms` milliseconds. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll the signature-responses contract at `RESPONSES_CONTRACT_ADDRESS` until
 * a VALID response for `requestId` appears, and return its payload as hex.
 *
 * Fetching, enumerating, and verifying the posts is delegated to
 * signet-midnight's {@link SignetRequestResponseReader}: the log is
 * unauthenticated, so each post must recover to the user's MPC-derived
 * address (`EVM_USER_ADDRESS`) over the requested transaction's signing hash,
 * and the first valid post wins. This command owns only the loop and the
 * reporting — each rejected post is warned once, not every tick.
 *
 * The MPC posts two payloads per request over the flow's lifetime: first the
 * signed EVM transaction, later the Schnorr-signed `(requestId, outputData)`
 * attestation of the EVM result. Attestation payloads do not verify under
 * this scheme yet — the attestation record and its verification are still to
 * be designed.
 *
 * @param context - The CLI context.
 * @param options - What to poll for and how patiently.
 * @returns The first valid response payload as lowercase hex, no `0x` prefix.
 * @throws Error when a contract has no state on-chain, the request is not on
 *   the vault's ledger, the responses ledger is inconsistent, or `timeoutMs`
 *   elapses with no valid response posted.
 */
export async function pollResponse(context: CliContext, options: PollResponseOptions): Promise<string> {
  const responsesContractAddress = requireConfigValue(
    context.config.responsesContractAddress,
    "RESPONSES_CONTRACT_ADDRESS",
  );
  const vaultContractAddress = requireConfigValue(
    context.config.vaultContractAddress,
    "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
  );
  const expectedSigner = requireConfigValue(context.config.evmUserAddress, "EVM_USER_ADDRESS");
  console.log(`responses contract: ${responsesContractAddress}`);
  console.log(`request id:         ${options.requestId}`);
  console.log(`expected signer:    ${expectedSigner}`);
  console.log(`poll:               every ${options.intervalMs}ms, up to ${options.timeoutMs}ms`);

  const reader = new SignetRequestResponseReader({
    requesterContractAddress: vaultContractAddress,
    responsesContractAddress,
    publicDataProvider: context.midnightProviders.indexerPublicDataProvider,
  });

  const warnedPosts = new Set<bigint>();
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const { verdicts } = await reader.getVerifiedSignatureResponse(
      options.requestId,
      expectedSigner,
    );

    for (const { count, rejectedReason } of verdicts) {
      if (rejectedReason !== undefined && !warnedPosts.has(count)) {
        warnedPosts.add(count);
        console.warn(`ignoring response post ${count}: ${rejectedReason}`);
      }
    }

    const valid = verdicts.find((v) => v.rejectedReason === undefined);
    if (valid !== undefined) {
      console.log(`valid response found (post ${valid.count} of ${verdicts.length})`);
      return bytesToHex(valid.response);
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${options.timeoutMs}ms waiting for a valid response to request ${options.requestId}`,
      );
    }
    await sleep(options.intervalMs);
  }
}
