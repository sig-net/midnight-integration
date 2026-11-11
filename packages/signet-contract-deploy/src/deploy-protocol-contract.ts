// The operator deploy flow of the protocol contracts, the signet signer
// and the signet responder: builds, balances, proves and submits a
// contract's deploy transaction using the generic plumbing in ./plumbing.
// What differs per contract, its compiled assets and private state, arrives
// as the transaction builder.

import { redactUrlQuery } from "@sig-net/midnight";

import { type DeployTransaction, getDeployConfig } from "./plumbing/deploy.ts";
import { envOrUndefined } from "./plumbing/env.ts";
import { formatDust } from "./plumbing/format-amounts.ts";
import {
  accountFunding,
  ensureFeeReady,
  formatFunding,
  formatUtxoBreakdown,
} from "./plumbing/funding.ts";
import {
  FAUCET_URL_ENV_VAR,
  getFaucetUrl,
  MIDNIGHT_NODE_CONFIG_ENV_VARS,
  type MidnightNodeConfig,
} from "./plumbing/midnight-node-config.ts";
import { isLocalStandaloneNetwork, type NetworkId } from "./plumbing/network-id.ts";
import {
  deriveAccountKeys,
  deriveAddresses,
  estimateUnprovenTransactionFee,
  submitUnprovenTransaction,
  type TransactionIdentifier,
  WalletRegistry,
} from "./plumbing/wallet.ts";

/** The outcome of a successful contract deployment. */
export interface ContractDeployment {
  /** Address of the deployed contract on Midnight. */
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
 * Tabulate every environment variable {@link deployProtocolContract} runs
 * with, except the secrets `DEPLOYER_SEED` and `BLOCKFROST_PROJECT_ID`, each
 * with its effective value and every URL's query values masked.
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
        value: redactUrlQuery(value),
        source:
          envOrUndefined(env, name) === undefined
            ? DeploySettingSource.Default
            : DeploySettingSource.Environment,
      },
    ]),
  );
}

/**
 * The line a deploy logs under its settings table: the deployer wallet's
 * NIGHT receive address, the one address a deploy needs funded.
 *
 * @param deployerSeed - The deploying wallet's seed (hex or mnemonic).
 * @param networkId - The network the address is encoded for.
 * @returns The log line naming the address.
 * @throws {Error} If the seed is rejected by key derivation.
 */
export function deployerFundingLine(deployerSeed: string, networkId: NetworkId): string {
  const { unshielded } = deriveAddresses(deriveAccountKeys(deployerSeed, networkId), networkId);
  return `deployer NIGHT address (fund this one): ${unshielded}`;
}

/**
 * Build one contract's unproven deploy transaction, typically a
 * `buildDeployTransaction` call over the contract's compiled assets.
 *
 * @param networkId - The network the transaction targets.
 * @param coinPublicKeyHex - The deploying wallet's Zswap coin public key (hex).
 * @returns The contract address and the serialized unproven transaction.
 */
export type DeployTransactionBuilder = (
  networkId: NetworkId,
  coinPublicKeyHex: string,
) => Promise<DeployTransaction>;

/**
 * Deploy a protocol contract: read config from `env`, build and prove the deploy
 * transaction and submit it through a synced wallet. Progress is logged to
 * the console, ending with `deployed <name> at <address>`, the line the
 * deploy workflow reads the address from. Any funded wallet can deploy, and
 * nothing about the deployer is sealed. The wallet needs NIGHT only:
 * {@link ensureFeeReady} registers it for dust generation and waits for the
 * deploy transaction's fee in spendable DUST when the wallet holds less.
 *
 * @param name - The contract's package directory name, for the log.
 * @param buildTransaction - Builds the contract's deploy transaction.
 * @param env - Environment map providing `DEPLOYER_SEED` and the shared
 *   Midnight node configuration (see `getMidnightNodeConfig`).
 * @param wallets - A registry to take the deployer wallet from, when the caller
 *   keeps wallets open across steps. Without one, a private registry is opened
 *   for this deploy and closed after it.
 * @returns The deployed contract address and deploy transaction id.
 * @throws {WalletUnfundedError} If the deployer wallet holds no NIGHT and
 *   less DUST than the deploy fee: the error carries the wallet's NIGHT receive address to fund.
 * @throws {Error} If the deploy's fee does not generate in spendable DUST after
 *   registering the wallet's NIGHT, or submission fails.
 */
export async function deployProtocolContract(
  name: string,
  buildTransaction: DeployTransactionBuilder,
  env: Record<string, string | undefined>,
  wallets?: WalletRegistry,
): Promise<ContractDeployment> {
  const deployConfig = getDeployConfig(env);
  const { networkId } = deployConfig.midnightNodeConfig;
  const registry = wallets ?? new WalletRegistry(deployConfig.midnightNodeConfig, env);

  console.log(`deploying ${name} to ${networkId} with:`);
  console.table(deployEnvironmentTable(env, deployConfig.midnightNodeConfig));

  try {
    // Logged ahead of the wallet sync, so the address can be funded while it runs.
    if (wallets === undefined && !isLocalStandaloneNetwork(networkId)) {
      console.log(deployerFundingLine(deployConfig.deployerSeed, networkId));
    }
    const { facade, keys } = await registry.wallet(deployConfig.deployerSeed, "deployer");
    const syncedState = await facade.waitForSyncedState();
    const funding = accountFunding(syncedState, deriveAddresses(keys, networkId));
    console.log(`deployer balance: ${formatFunding(funding)}\n${formatUtxoBreakdown(syncedState)}`);

    const deployTransaction = await buildTransaction(
      networkId,
      keys.shieldedSecretKeys.coinPublicKey,
    );
    console.log(`contract address (pre-submit): ${deployTransaction.contractAddress}`);

    // The one transaction this deploy submits, priced before anything is sent.
    const fee = await estimateUnprovenTransactionFee(
      facade,
      deployTransaction.serializedTransaction,
    );
    console.log(`fee budget: 1 transaction at about ${formatDust(fee)} DUST`);
    const state = await facade.waitForSyncedState();
    await ensureFeeReady(facade, keys, state, networkId, getFaucetUrl(env, networkId), fee);

    const txId = await submitUnprovenTransaction(
      facade,
      keys,
      deployTransaction.serializedTransaction,
    );
    const { contractAddress } = deployTransaction;
    console.log(`submitted deploy tx ${txId}`);
    console.log(`deployed ${name} at ${contractAddress}`);
    return { contractAddress, txId };
  } finally {
    if (wallets === undefined) await registry.close();
  }
}
