// `poll-signature-response` — stage 1 of the MPC round trip: poll the
// central signet contract's signature response log for the MPC's ECDSA
// signature over a request's EVM transaction. There is deliberately no
// push/websocket alternative.

import {
  bytesToHex,
  SignetRequestResponseReader,
  type SignetRequestIdHex,
} from "@midnight-erc20-vault/signet-midnight";

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";

/** Options for {@link pollSignatureResponse}. */
export interface PollSignatureResponseOptions {
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
 * Poll the signet contract at `SIGNET_CONTRACT_ADDRESS` until a VALID
 * signature response for `requestId` appears, and return the 65-byte
 * `r||s||v` signature as hex.
 *
 * Fetching, enumerating, and verifying the posts is delegated to
 * signet-midnight's {@link SignetRequestResponseReader}: the signature
 * response log is unauthenticated (secp256k1 cannot be verified in-circuit),
 * so each post must recover to the user's MPC-derived address
 * (`EVM_USER_ADDRESS`) over the requested transaction's signing hash, and
 * the first valid post wins. This command owns only the loop and the
 * reporting — each rejected post is warned once, not every tick. For the
 * MPC's attestation of the EVM result, see `poll-remote-execution-response`.
 *
 * @param context - The CLI context.
 * @param options - What to poll for and how patiently.
 * @returns The first valid signature as lowercase hex, no `0x` prefix.
 * @throws Error when a contract has no state on-chain, the request is not on
 *   the vault's ledger, the responses ledger is inconsistent, or `timeoutMs`
 *   elapses with no valid response posted.
 */
export async function pollSignatureResponse(context: CliContext, options: PollSignatureResponseOptions): Promise<string> {
  const signetContractAddress = requireConfigValue(
    context.config.signetContractAddress,
    "SIGNET_CONTRACT_ADDRESS",
  );
  const vaultContractAddress = requireConfigValue(
    context.config.vaultContractAddress,
    "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
  );
  const expectedSigner = requireConfigValue(context.config.evmUserAddress, "EVM_USER_ADDRESS");
  console.log(`signet contract:   ${signetContractAddress}`);
  console.log(`request id:         ${options.requestId}`);
  console.log(`expected signer:    ${expectedSigner}`);
  console.log(`poll:               every ${options.intervalMs}ms, up to ${options.timeoutMs}ms`);

  const reader = new SignetRequestResponseReader({
    requesterContractAddress: vaultContractAddress,
    signetContractAddress,
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
