// Signet-contract deploy flow: builds, balances, proves and submits the
// contract's deploy transaction using the generic plumbing in ./plumbing.
// Everything contract-specific lives HERE: the (empty) private state — the
// contract has no constructor arguments (every store is an unauthenticated
// append-only log; verification is the reader's job). Requires the contract
// package's compiled assets to carry keys (its published dist/managed
// always does; an in-repo checkout needs `yarn compile:zk`).

import {
  assertDeployerFunded,
  buildDeployTransaction,
  getDeployConfig,
} from "./plumbing/deploy.ts";
import {
  deriveAccountKeys,
  submitUnprovenTransaction,
  withSyncedWalletFacade,
  type TransactionIdentifier,
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
 * funded wallet can deploy; nothing about the deployer is sealed.
 *
 * @param env - Environment map providing `DEPLOYER_SEED` and the shared
 *   Midnight node configuration (see `getMidnightNodeConfig`).
 * @returns The deployed contract address and deploy transaction id.
 * @throws If the deployer wallet holds no funds or submission fails.
 */
export async function deploySignetContract(
  env: Record<string, string | undefined> = process.env,
): Promise<SignetContractDeployment> {
  const deployConfig = getDeployConfig(env);
  const { networkId } = deployConfig.midnightNodeConfig;

  const accountKeys = deriveAccountKeys(deployConfig.deployerSeed, networkId);

  console.log(`deploying signet-contract to ${networkId} (${deployConfig.midnightNodeConfig.nodeUrl})`);

  const { contractAddress, txId } = await withSyncedWalletFacade(
    accountKeys,
    deployConfig.midnightNodeConfig,
    async (facade, state) => {
      assertDeployerFunded(state);

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
