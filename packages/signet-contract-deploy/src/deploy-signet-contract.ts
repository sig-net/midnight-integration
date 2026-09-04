// Signet-contract deploy flow: builds, balances, proves and submits the
// contract's deploy transaction using the generic plumbing in ./plumbing.
// Everything contract-specific lives HERE: the (empty) private state. The
// contract has no constructor arguments (it only emits unauthenticated
// events: verification is the reader's job). Requires the contract
// package's compiled assets to carry keys (its published dist/managed
// always does; an in-repo checkout needs `yarn compile:zk`).

import { buildDeployTransaction, getDeployConfig } from "./plumbing/deploy.ts";
import { ensureFeeReady } from "./plumbing/funding.ts";
import { getFaucetUrl } from "./plumbing/midnight-node-config.ts";
import {
  deriveAccountKeys,
  submitUnprovenTransaction,
  type TransactionIdentifier,
  withSyncedWalletFacade,
} from "./plumbing/wallet.ts";
import {
  createSignetContractPrivateState,
  signetContractCompiledContract,
} from "./signet-contract-binding.ts";

/** The outcome of a successful signet-contract deployment. */
export interface SignetContractDeployment {
  /** Address of the deployed signet contract on Midnight. */
  contractAddress: string;
  /** Identifier of the submitted deploy transaction. */
  txId: TransactionIdentifier;
}

/**
 * Deploy the signet contract: read config from `env`, build and prove the
 * deploy transaction and submit it through a synced wallet. Progress is
 * logged to the console. The contract takes no constructor arguments. Any
 * funded wallet can deploy; nothing about the deployer is sealed. The wallet
 * needs NIGHT only: {@link ensureFeeReady} registers it for dust generation
 * and waits for the first spendable DUST when the wallet has none yet.
 *
 * @param env - Environment map providing `DEPLOYER_SEED` and the shared
 *   Midnight node configuration (see `getMidnightNodeConfig`).
 * @returns The deployed contract address and deploy transaction id.
 * @throws {WalletUnfundedError} If the deployer wallet holds neither NIGHT
 *   nor DUST: the error carries the wallet's NIGHT receive address to fund.
 * @throws {Error} If no spendable DUST appears after registering the wallet's
 *   NIGHT, or submission fails.
 */
export async function deploySignetContract(
  env: Record<string, string | undefined> = process.env,
): Promise<SignetContractDeployment> {
  const deployConfig = getDeployConfig(env);
  const { networkId } = deployConfig.midnightNodeConfig;

  const accountKeys = deriveAccountKeys(deployConfig.deployerSeed, networkId);

  console.log(
    `deploying signet-contract to ${networkId} (${deployConfig.midnightNodeConfig.nodeUrl})`,
  );

  const { contractAddress, txId } = await withSyncedWalletFacade(
    accountKeys,
    deployConfig.midnightNodeConfig,
    async (facade, state) => {
      await ensureFeeReady(facade, accountKeys, state, networkId, getFaucetUrl(env, networkId));

      const deployTransaction = await buildDeployTransaction(
        signetContractCompiledContract,
        networkId,
        accountKeys.shieldedSecretKeys.coinPublicKey,
        createSignetContractPrivateState(),
      );
      console.log(`contract address (pre-submit): ${deployTransaction.contractAddress}`);

      const submittedTxId = await submitUnprovenTransaction(
        facade,
        accountKeys,
        deployTransaction.serializedTransaction,
      );
      return { contractAddress: deployTransaction.contractAddress, txId: submittedTxId };
    },
  );

  console.log(`submitted deploy tx ${txId}`);
  console.log(`deployed signet-contract at ${contractAddress}`);

  return { contractAddress, txId };
}
