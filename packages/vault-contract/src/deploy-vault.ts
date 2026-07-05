// Vault deploy flow: builds, balances, proves and submits the vault's deploy
// transaction using the generic plumbing in @midnight-erc20-vault/lib.
// Everything contract-specific lives HERE: the constructor arg
// (deployerCommitment), the witnesses, and the private state. Requires
// `npm run compile:zk` output (verifier keys) in src/managed.

import { fileURLToPath } from "node:url";

import {
  assertDeployerFunded,
  buildDeployTransaction,
  deriveAccountKeys,
  getDeployConfig,
  makeCompiledContract,
  parseIdentitySecretKey,
  submitUnprovenTransaction,
  withSyncedWalletFacade,
  type TransactionIdentifier,
} from "@midnight-erc20-vault/lib";

import { Contract, pureCircuits } from "./managed/contract/index.js";
import { createVaultPrivateState, witnesses, type VaultPrivateState } from "./witnesses.ts";

/** The outcome of a successful vault deployment. */
export interface VaultDeployment {
  /** Address of the deployed vault contract on Midnight. */
  contractAddress: string;
  /** Identifier of the submitted deploy transaction. */
  txId: TransactionIdentifier;
}

/**
 * Deploy the vault contract: read config from `env`, derive the deployer
 * identity, build/prove the deploy transaction and submit it through a synced
 * wallet. Progress is logged to the console.
 *
 * The deployer identity comes from `VAULT_DEPLOYER_SECRET_KEY` (falling back
 * to the `DEPLOYER_SEED` bytes): its commitment is sealed into the contract
 * as `deployer`, and the same secret must later answer the `callerSecretKey`
 * witness to pass `initialize`'s gate.
 *
 * @param env - Environment map providing `DEPLOYER_SEED`,
 *   `VAULT_DEPLOYER_SECRET_KEY` and lib's Midnight node configuration.
 * @returns The deployed contract address and deploy transaction id.
 * @throws If the deployer wallet holds no funds or submission fails.
 */
export async function deployVault(env: Record<string, string | undefined> = process.env): Promise<VaultDeployment> {
  const deployConfig = getDeployConfig(env);
  const { networkId } = deployConfig.midnightNodeConfig;

  const secretKey = parseIdentitySecretKey("VAULT_DEPLOYER_SECRET_KEY", env, deployConfig.deployerSeed);
  const deployerCommitment = pureCircuits.userCommitment(secretKey);

  const compiledContract = makeCompiledContract<Contract<VaultPrivateState>, VaultPrivateState>(
    "erc20-vault",
    Contract,
    witnesses,
    fileURLToPath(new URL("./managed", import.meta.url)),
  );

  const accountKeys = deriveAccountKeys(deployConfig.deployerSeed, networkId);

  console.log(`deploying erc20-vault to ${networkId} (${deployConfig.midnightNodeConfig.nodeUrl})`);

  const { contractAddress, txId } = await withSyncedWalletFacade(
    accountKeys,
    deployConfig.midnightNodeConfig,
    async (facade, state) => {
      assertDeployerFunded(state);

      const deployTransaction = await buildDeployTransaction(
        compiledContract,
        networkId,
        accountKeys.shieldedSecretKeys.coinPublicKey,
        createVaultPrivateState(secretKey),
        deployerCommitment,
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
  console.log(`deployed erc20-vault at ${contractAddress}`);

  return { contractAddress, txId };
}
