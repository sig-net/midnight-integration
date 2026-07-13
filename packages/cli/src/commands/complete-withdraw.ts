// `complete-withdraw` — the settle call of the withdraw flow. It settles
// BOTH branches: on EVM success the withdrawal is final; on failure the
// surrendered value is re-minted to the pinned refund recipient.
// Permissionless: anyone may call it, the refund always goes to the pinned
// recipient.

import {
  executionSucceeded,
  requestIdBytes,
  SignetRequestResponseReader,
  type RequestIdHex,
} from "@sig-net/midnight";

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";

/** Options for {@link completeWithdraw}. */
export interface CompleteWithdrawOptions {
  /** The request id being settled. */
  readonly requestId: RequestIdHex;
}

/**
 * Call the vault's `completeWithdraw` circuit for a completed withdraw
 * request.
 *
 * Fetches the MPC's respond-bidirectional attestation (`serializedOutput` +
 * Schnorr signature components) for `requestId` from the signet contract via
 * the {@link SignetRequestResponseReader} — the same read the response server
 * writes to — then calls the circuit, which verifies the MPC public key hash
 * and the Schnorr signature, consumes the pending withdrawal, and branches on
 * the EVM result: success finalizes the withdrawal (the surrendered value
 * stays burned); failure re-mints it to the refund recipient pinned at
 * request time. The refund's coin handling is midnight-js's job:
 * `vault.callTx.completeWithdraw(...)` balances the resulting offer like any
 * other call.
 *
 * The attestation is authentic by construction: the signet contract verified
 * it IN-CIRCUIT at post time, so a stored record needs no off-chain re-check
 * here — an absent one just means the MPC has not attested yet (poll first).
 *
 * @param context - The CLI context.
 * @param options - The settle arguments.
 * @throws If required config is missing, or no attestation has been posted for
 *   `requestId` yet.
 */
export async function completeWithdraw(context: CliContext, options: CompleteWithdrawOptions): Promise<void> {
  const vaultContractAddress = requireConfigValue(context.config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
  const signetContractAddress = requireConfigValue(context.config.signetContractAddress, "MIDNIGHT_SIGNET_CONTRACT_ADDRESS");
  console.log(`vault contract:  ${vaultContractAddress}`);
  console.log(`signet contract: ${signetContractAddress}`);
  console.log(`request id:      ${options.requestId}`);

  const reader = new SignetRequestResponseReader({
    requesterContractAddress: vaultContractAddress,
    signetContractAddress,
    publicDataProvider: context.midnightProviders.indexerPublicDataProvider,
  });

  const respondBidirectional = await reader.getRespondBidirectional(options.requestId);
  if (respondBidirectional === undefined) {
    throw new Error(
      `no respond-bidirectional attestation posted for request ${options.requestId} — ` +
        `run poll-respond-bidirectional first (has the MPC attested the transfer?)`,
    );
  }

  const outcome = executionSucceeded(respondBidirectional.serializedOutput)
    ? "EVM transfer succeeded — settling final"
    : "EVM transfer failed — settling with a refund to the pinned recipient";
  console.log(outcome);

  const result = await context.vault.callTx.completeWithdraw(
    requestIdBytes(options.requestId),
    respondBidirectional,
  );
  console.log(`completeWithdraw settled in tx ${result.public.txId}`);
}
