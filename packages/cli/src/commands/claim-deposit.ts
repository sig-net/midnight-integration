// `claim-deposit` — the second half of the deposit flow: present the MPC's
// Schnorr-signed attestation of the EVM sweep to the vault, which verifies it
// in-circuit and mints shielded tokens to the caller.

import {
  requestIdBytes,
  SignetRequestResponseReader,
  type RequestIdHex,
} from "@midnight-erc20-vault/signet-midnight";

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";

/** Options for {@link claimDeposit}. */
export interface ClaimDepositOptions {
  /** The request id being claimed. */
  readonly requestId: RequestIdHex;
}

/**
 * Call the vault's `claimDeposit` circuit for a completed deposit request.
 *
 * Fetches the MPC's respond-bidirectional attestation (`serializedOutput` +
 * Schnorr signature components) for `requestId` from the signet contract via
 * the {@link SignetRequestResponseReader} — the same read the response server
 * writes to — then calls the circuit, which verifies the MPC public key hash,
 * the Schnorr signature, the EVM success flag, and the caller identity against
 * the stored request, and mints shielded vault tokens on success. The mint's
 * coin handling is midnight-js's job: `vault.callTx.claimDeposit(...)`
 * balances the resulting offer like any other call.
 *
 * The attestation is authentic by construction: the signet contract verified
 * it IN-CIRCUIT at post time, so a stored record needs no off-chain re-check
 * here — an absent one just means the MPC has not attested yet (poll first).
 *
 * @param context - The CLI context.
 * @param options - The claim arguments.
 * @throws If required config is missing, or no attestation has been posted for
 *   `requestId` yet.
 */
export async function claimDeposit(context: CliContext, options: ClaimDepositOptions): Promise<void> {
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
        `run poll-respond-bidirectional first (has the MPC attested the sweep?)`,
    );
  }

  const result = await context.vault.callTx.claimDeposit(
    requestIdBytes(options.requestId),
    respondBidirectional,
  );
  console.log(`claimDeposit finalized in tx ${result.public.txId}`);
}
