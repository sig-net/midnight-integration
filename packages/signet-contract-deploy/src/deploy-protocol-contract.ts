// The operator deploy flow of the protocol contracts, the signet signer
// and the signet responder: builds, balances, proves and submits a
// contract's deploy transaction using the generic plumbing in ./plumbing.
// What differs per contract, its compiled assets and private state, arrives
// as the transaction builder.

import * as ledger from "@midnightntwrk/ledger-v9";
import { redactUrlQuery } from "@sig-net/midnight";

import { type DeployConfig, type DeployTransaction, getDeployConfig } from "./plumbing/deploy.ts";
import { formatNightToGenerateDust } from "./plumbing/dust-generation.ts";
import { envOrUndefined } from "./plumbing/env.ts";
import { formatDust } from "./plumbing/format-amounts.ts";
import {
  type AccountFunding,
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
  type RegisteredWallet,
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
  try {
    const { wallet, deployTransaction, fee } = await prepareProtocolContractDeploy(
      `deploying ${name} to ${networkId} with:`,
      buildTransaction,
      env,
      deployConfig,
      registry,
      wallets === undefined,
    );
    const { facade, keys } = wallet;
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

/** What a protocol contract's deploy is priced at, with nothing submitted. */
export interface ContractDeployEstimate {
  /** The address the built deploy transaction would create, which differs on every build. */
  readonly contractAddress: string;
  /** The deploy transaction's fee in SPECKs, before the balancing inputs' own fee. */
  readonly fee: bigint;
  /** The deployer wallet's balances when the estimate was taken. */
  readonly funding: AccountFunding;
}

/**
 * Price a protocol contract's deploy without submitting anything: sync the
 * deployer wallet, build the deploy transaction and log the wallet's
 * balances, the transaction's fee and the NIGHT that generates that fee
 * (see `formatNightToGenerateDust`). No NIGHT is registered and no
 * transaction leaves the process.
 *
 * @param name - The contract's package directory name, for the log.
 * @param buildTransaction - Builds the contract's deploy transaction.
 * @param env - Environment map providing `DEPLOYER_SEED` and the shared
 *   Midnight node configuration (see `getMidnightNodeConfig`).
 * @param wallets - A registry to take the deployer wallet from. Without one,
 *   a private registry is opened for this estimate and closed after it.
 * @returns The estimate.
 * @throws {Error} If the deployer wallet cannot be synced or the transaction cannot be built or priced.
 */
export async function estimateProtocolContractDeploy(
  name: string,
  buildTransaction: DeployTransactionBuilder,
  env: Record<string, string | undefined>,
  wallets?: WalletRegistry,
): Promise<ContractDeployEstimate> {
  const deployConfig = getDeployConfig(env);
  const { networkId } = deployConfig.midnightNodeConfig;
  const registry = wallets ?? new WalletRegistry(deployConfig.midnightNodeConfig, env);
  try {
    const { deployTransaction, fee, funding } = await prepareProtocolContractDeploy(
      `estimating the deploy of ${name} to ${networkId} with:`,
      buildTransaction,
      env,
      deployConfig,
      registry,
      wallets === undefined,
    );
    console.log(
      `estimate only (${DEPLOY_ESTIMATE_ONLY_ENV_VAR}=1): ${name} was not deployed and nothing was submitted`,
    );
    return { contractAddress: deployTransaction.contractAddress, fee, funding };
  } finally {
    if (wallets === undefined) await registry.close();
  }
}

/** The environment variable that turns a deploy entrypoint into an estimate (see {@link isDeployEstimateOnly}). */
export const DEPLOY_ESTIMATE_ONLY_ENV_VAR = "DEPLOY_ESTIMATE_ONLY";

/**
 * Whether the environment asks a deploy entrypoint to price its deploy with
 * {@link estimateProtocolContractDeploy} and stop. Only `1` asks for it, and
 * any other set value is refused, so a misspelt request never deploys.
 *
 * @param env - The environment to read `DEPLOY_ESTIMATE_ONLY` from.
 * @returns True for `1`, false when unset, blank or `0`.
 * @throws {Error} If the variable holds anything else.
 */
export function isDeployEstimateOnly(env: Record<string, string | undefined>): boolean {
  const raw = envOrUndefined(env, DEPLOY_ESTIMATE_ONLY_ENV_VAR);
  if (raw === undefined || raw === "0") return false;
  if (raw === "1") return true;
  throw new Error(`${DEPLOY_ESTIMATE_ONLY_ENV_VAR} must be 1 or 0, got "${raw}"`);
}

/** A deploy priced and ready to submit. */
interface PreparedDeploy {
  readonly wallet: RegisteredWallet;
  readonly deployTransaction: DeployTransaction;
  readonly fee: bigint;
  readonly funding: AccountFunding;
}

/**
 * The part a deploy and its estimate share: log the settings, sync the
 * deployer wallet, build the deploy transaction and log the balances and
 * the fee. Submits nothing.
 *
 * @param heading - The line logged above the settings table.
 * @param buildTransaction - Builds the contract's deploy transaction.
 * @param env - The environment the deploy reads.
 * @param deployConfig - The deploy config resolved from `env`.
 * @param registry - The registry to take the deployer wallet from.
 * @param announceFundingAddress - Whether to log the deployer's NIGHT address ahead of the sync.
 * @returns The wallet, the built transaction, its fee and the wallet's balances.
 */
async function prepareProtocolContractDeploy(
  heading: string,
  buildTransaction: DeployTransactionBuilder,
  env: Record<string, string | undefined>,
  deployConfig: DeployConfig,
  registry: WalletRegistry,
  announceFundingAddress: boolean,
): Promise<PreparedDeploy> {
  const { networkId } = deployConfig.midnightNodeConfig;
  console.log(heading);
  console.table(deployEnvironmentTable(env, deployConfig.midnightNodeConfig));

  // Logged ahead of the wallet sync, so the address can be funded while it runs.
  if (announceFundingAddress && !isLocalStandaloneNetwork(networkId)) {
    console.log(deployerFundingLine(deployConfig.deployerSeed, networkId));
  }
  const wallet = await registry.wallet(deployConfig.deployerSeed, "deployer");
  const syncedState = await wallet.facade.waitForSyncedState();
  const funding = accountFunding(syncedState, deriveAddresses(wallet.keys, networkId));
  console.log(`deployer balance: ${formatFunding(funding)}\n${formatUtxoBreakdown(syncedState)}`);

  const deployTransaction = await buildTransaction(
    networkId,
    wallet.keys.shieldedSecretKeys.coinPublicKey,
  );
  console.log(`contract address (pre-submit): ${deployTransaction.contractAddress}`);

  const fee = await estimateUnprovenTransactionFee(
    wallet.facade,
    deployTransaction.serializedTransaction,
  );
  console.log(
    `estimated fee budget: ${formatDust(fee)} DUST for 1 transaction (balancing fees additional)`,
  );
  console.log(formatNightToGenerateDust(fee, ledger.LedgerParameters.initialParameters().dust));
  return { wallet, deployTransaction, fee, funding };
}
