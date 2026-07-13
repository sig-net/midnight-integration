// `claim-deposit` — the second half of the deposit flow: present the MPC's
// Schnorr-signed attestation of the EVM sweep to the vault, which verifies it
// in-circuit and mints shielded tokens to the caller (or a recipient the
// caller names).

import { encodeCoinPublicKey, type CoinPublicKey } from "@midnight-ntwrk/compact-runtime";
import { withContractScopedTransaction } from "@midnight-ntwrk/midnight-js/contracts";

import type { EncPublicKey } from "@midnight-erc20-vault/lib";
import {
  requestIdBytes,
  SignetRequestResponseReader,
  type RequestIdHex,
} from "@sig-net/midnight";

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";

/**
 * A shielded wallet the vault can mint to. Both halves of the key pair are
 * needed: the coin public key addresses the coin, and the encryption public
 * key encrypts the output's ciphertext so the recipient wallet can DISCOVER
 * the coin while syncing — without it, midnight-js cannot build an output to
 * a key that is not the caller's own.
 */
export interface ShieldedTokenRecipient {
  /** Coin public key the minted coin is addressed to. */
  readonly coinPublicKey: CoinPublicKey;
  /** Encryption public key of the same wallet, for output discovery. */
  readonly encryptionPublicKey: EncPublicKey;
}

/** Options for {@link claimDeposit}. */
export interface ClaimDepositOptions {
  /** The request id being claimed. */
  readonly requestId: RequestIdHex;
  /**
   * The wallet receiving the minted tokens; the caller's own wallet when
   * omitted. Only the DEPOSITOR may claim either way — this redirects the
   * mint, not the right to claim.
   */
  readonly recipient?: ShieldedTokenRecipient;
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
    console.log(`recipient:       ${options.recipient.coinPublicKey}`);
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
            ? encodeCoinPublicKey(options.recipient.coinPublicKey)
            : new Uint8Array(32),
      },
      right: { bytes: new Uint8Array(32) },
    },
  };

  // Minting to another wallet's key needs that wallet's encryption public
  // key mapped in, or midnight-js cannot encrypt the output's ciphertext and
  // rejects the transaction build; a scoped transaction is the only carrier
  // for such mappings. The caller's own wallet resolves implicitly.
  const result =
    options.recipient !== undefined
      ? await withContractScopedTransaction(
          context.providers,
          async (txCtx) => {
            await context.vault.callTx.claimDeposit(
              txCtx,
              requestIdBytes(options.requestId),
              respondBidirectional,
              recipient,
            );
          },
          {
            additionalCoinEncPublicKeyMappings: new Map([
              [options.recipient.coinPublicKey, options.recipient.encryptionPublicKey],
            ]),
          },
        )
      : await context.vault.callTx.claimDeposit(
          requestIdBytes(options.requestId),
          respondBidirectional,
          recipient,
        );
  console.log(`claimDeposit finalized in tx ${result.public.txId}`);
}
