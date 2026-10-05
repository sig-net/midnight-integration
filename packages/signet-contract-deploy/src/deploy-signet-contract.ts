// Signet-contract deploy flow: builds, balances, proves and submits the
// contract's deploy transaction using the generic plumbing in ./plumbing.
// Everything contract-specific lives HERE: the (empty) private state. The
// contract has no constructor arguments (it only emits unauthenticated
// events: verification is the reader's job). Requires the contract
// package's compiled assets to carry keys (its published dist/managed
// always does; an in-repo checkout needs `yarn compile:zk`).

import { buildDeployTransaction, getDeployConfig } from "./plumbing/deploy.ts";
import { envOrUndefined } from "./plumbing/env.ts";
import { ensureFeeReady } from "./plumbing/funding.ts";
import {
  FAUCET_URL_ENV_VAR,
  getFaucetUrl,
  MIDNIGHT_NODE_CONFIG_ENV_VARS,
  type MidnightNodeConfig,
} from "./plumbing/midnight-node-config.ts";
import {
  estimateUnprovenTransactionFee,
  submitUnprovenTransaction,
  type TransactionIdentifier,
  WalletRegistry,
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

/** Where a deploy setting's effective value came from. */
export enum DeploySettingSource {
  /** The environment variable is set. */
  Environment = "environment",
  /** The variable is unset or blank, so the built-in value applies. */
  Default = "default",
}

/** One row of {@link deployEnvironmentTable}. */
export interface DeploySettingRow {
  /** The value the deploy runs with. */
  value: string;
  /** Whether the environment or the built-in default supplied {@link value}. */
  source: DeploySettingSource;
}

/**
 * Tabulate every environment variable a signet-contract deploy runs with,
 * except the secret `DEPLOYER_SEED`, each with its effective value.
 *
 * @param env - The environment the deploy reads.
 * @param midnightNodeConfig - The node config resolved from `env`.
 * @returns One row per variable, keyed by variable name.
 */
export function deployEnvironmentTable(
  env: Record<string, string | undefined>,
  midnightNodeConfig: MidnightNodeConfig,
): Record<string, DeploySettingRow> {
  const values: Record<string, string> = {
    [MIDNIGHT_NODE_CONFIG_ENV_VARS.networkId]: midnightNodeConfig.networkId,
    [MIDNIGHT_NODE_CONFIG_ENV_VARS.nodeUrl]: midnightNodeConfig.nodeUrl,
    [MIDNIGHT_NODE_CONFIG_ENV_VARS.indexerUrl]: midnightNodeConfig.indexerUrl,
    [MIDNIGHT_NODE_CONFIG_ENV_VARS.indexerWsUrl]: midnightNodeConfig.indexerWsUrl,
    [MIDNIGHT_NODE_CONFIG_ENV_VARS.proofServerUrl]: midnightNodeConfig.proofServerUrl,
    [FAUCET_URL_ENV_VAR]: getFaucetUrl(env, midnightNodeConfig.networkId) ?? "(none)",
  };
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      {
        value,
        source:
          envOrUndefined(env, name) === undefined
            ? DeploySettingSource.Default
            : DeploySettingSource.Environment,
      },
    ]),
  );
}

/**
 * Deploy the signet contract: read config from `env`, build and prove the
 * deploy transaction and submit it through a synced wallet. Progress is
 * logged to the console. The contract takes no constructor arguments. Any
 * funded wallet can deploy, and nothing about the deployer is sealed. The wallet
 * needs NIGHT only: {@link ensureFeeReady} registers it for dust generation
 * and waits for the deploy transaction's fee in spendable DUST when the
 * wallet holds less.
 *
 * @param env - Environment map providing `DEPLOYER_SEED` and the shared
 *   Midnight node configuration (see `getMidnightNodeConfig`).
 * @param wallets - A registry to take the deployer wallet from, when the caller
 *   keeps wallets open across steps. Without one, a private registry is opened
 *   for this deploy and closed after it.
 * @returns The deployed contract address and deploy transaction id.
 * @throws {WalletUnfundedError} If the deployer wallet holds neither NIGHT
 *   nor DUST: the error carries the wallet's NIGHT receive address to fund.
 * @throws {Error} If the deploy's fee does not generate in spendable DUST after
 *   registering the wallet's NIGHT, or submission fails.
 */
export async function deploySignetContract(
  env: Record<string, string | undefined> = process.env,
  wallets?: WalletRegistry,
): Promise<SignetContractDeployment> {
  const deployConfig = getDeployConfig(env);
  const { networkId } = deployConfig.midnightNodeConfig;
  const registry = wallets ?? new WalletRegistry(deployConfig.midnightNodeConfig);

  console.log(`deploying signet-contract to ${networkId} with:`);
  console.table(deployEnvironmentTable(env, deployConfig.midnightNodeConfig));

  try {
    const { facade, keys } = await registry.wallet(deployConfig.deployerSeed, "deployer");

    const deployTransaction = await buildDeployTransaction(
      signetContractCompiledContract,
      networkId,
      keys.shieldedSecretKeys.coinPublicKey,
      createSignetContractPrivateState(),
    );
    console.log(`contract address (pre-submit): ${deployTransaction.contractAddress}`);

    // The one transaction this deploy submits, priced before anything is sent.
    const fee = await estimateUnprovenTransactionFee(
      facade,
      deployTransaction.serializedTransaction,
    );
    console.log(`fee budget: 1 transaction at about ${String(fee)} DUST`);
    const state = await facade.waitForSyncedState();
    await ensureFeeReady(facade, keys, state, networkId, getFaucetUrl(env, networkId), fee);

    const txId = await submitUnprovenTransaction(
      facade,
      keys,
      deployTransaction.serializedTransaction,
    );
    const { contractAddress } = deployTransaction;
    console.log(`submitted deploy tx ${txId}`);
    console.log(`deployed signet-contract at ${contractAddress}`);
    return { contractAddress, txId };
  } finally {
    if (wallets === undefined) await registry.close();
  }
}
