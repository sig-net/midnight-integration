// `claim-deposit` — the second half of the deposit flow: present the MPC's
// Schnorr-signed attestation of the EVM sweep to the vault, which verifies it
// in-circuit and mints shielded tokens to the caller (or a recipient the
// caller names).

import { encodeCoinPublicKey, type CoinPublicKey } from "@midnight-ntwrk/compact-runtime";

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
  /**
   * Coin public key of the wallet receiving the minted tokens; the caller's
   * own wallet when omitted. Only the DEPOSITOR may claim either way — this
   * redirects the mint, not the right to claim.
   */
  readonly recipient?: CoinPublicKey;
}

/**
 * Call the vault's `claimDeposit` circuit for a completed deposit request.
 *
 * Fetches the MPC's respond-bidirectional attestation (`serializedOutput` +
 * Schnorr signature components) for `requestId` from the signet contract via
 * the {@link SignetRequestResponseReader} — the same read the response server
 * writes to — then calls the circuit, which verifies the MPC public key hash,
 * the Schnorr signature, the EVM success flag, and the caller identity against
 * the stored request, and mints shielded vault tokens on success — to
 * `options.recipient` when given, otherwise to the caller. The mint's
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
  if (options.recipient !== undefined) {
    console.log(`recipient:       ${options.recipient}`);
  }

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

  // The circuit's Maybe<Either<ZswapCoinPublicKey, ContractAddress>> recipient.
  // Compact's Maybe/Either are plain structs: a `none` (and the unused
  // ContractAddress side) still carries a default-valued payload.
  const recipient = {
    is_some: options.recipient !== undefined,
    value: {
      is_left: true,
      left: {
        bytes:
          options.recipient !== undefined
            ? encodeCoinPublicKey(options.recipient)
            : new Uint8Array(32),
      },
      right: { bytes: new Uint8Array(32) },
    },
  };

  const result = await context.vault.callTx.claimDeposit(
    requestIdBytes(options.requestId),
    respondBidirectional,
    recipient,
  );
  console.log(`claimDeposit finalized in tx ${result.public.txId}`);
}
