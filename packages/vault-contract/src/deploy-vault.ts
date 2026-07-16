// Vault deploy flow: builds, balances, proves and submits the vault's deploy
// transaction using the generic plumbing in @sig-net/midnight-contract-deploy.
// Everything contract-specific lives HERE: the constructor arg
// (deployerCommitment), the witnesses, and the private state. Requires
// `yarn compile:zk` output (verifier keys) in src/managed.

import { fileURLToPath } from "node:url";

import {
  assertDeployerFunded,
  buildDeployTransaction,
  contractAddressToReference,
  deriveAccountKeys,
  getDeployConfig,
  makeCompiledContract,
  parseIdentitySecretKey,
  submitUnprovenTransaction,
  withSyncedWalletFacade,
  type TransactionIdentifier,
} from "@sig-net/midnight-contract-deploy";
import { parseJubjubPublicKey } from "@sig-net/midnight";

import { Contract, pureCircuits } from "./managed/erc20-vault/contract/index.js";
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
 * witness to pass `initialize`'s gate. The MPC attestation key
 * (`MPC_JUBJUB_PK`, "x,y" decimal or 0x-hex field coordinates) is sealed as
 * `mpcPubKeyHash` — claim accepts only attestations signed by it.
 *
 * @param env - Environment map providing `DEPLOYER_SEED`,
 *   `VAULT_DEPLOYER_SECRET_KEY`, `MPC_JUBJUB_PK`,
 *   `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` (the signet contract to seal as the
 *   cross-contract emitter) and the shared Midnight node configuration (see `getMidnightNodeConfig`).
 * @returns The deployed contract address and deploy transaction id.
 * @throws If `MPC_JUBJUB_PK` or `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` is
 *   missing/malformed, the deployer wallet holds no funds, or submission fails.
 */
export async function deployVault(env: Record<string, string | undefined> = process.env): Promise<VaultDeployment> {
  const deployConfig = getDeployConfig(env);
  const { networkId } = deployConfig.midnightNodeConfig;

  const secretKey = parseIdentitySecretKey("VAULT_DEPLOYER_SECRET_KEY", env, deployConfig.deployerSeed);
  const deployerCommitment = pureCircuits.userCommitment(secretKey);

  const mpcPkRaw = env.MPC_JUBJUB_PK?.trim();
  if (!mpcPkRaw) {
    throw new Error("MPC_JUBJUB_PK is required (the MPC attestation key, as \"x,y\")");
  }
  const mpcPk = parseJubjubPublicKey(mpcPkRaw);

  // The signet contract the vault cross-contract-calls to register signature
  // request notifications — sealed into the vault as the SignetNotifier
  // reference, so it must be deployed first.
  const signetContractAddress = env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS?.trim();
  if (!signetContractAddress) {
    throw new Error("MIDNIGHT_SIGNET_CONTRACT_ADDRESS is required (deploy the signet contract first)");
  }
  const signetNotifier = contractAddressToReference(signetContractAddress);

  const compiledContract = makeCompiledContract<Contract<VaultPrivateState>, VaultPrivateState>(
    "erc20-vault",
    Contract,
    witnesses,
    fileURLToPath(new URL("./managed/erc20-vault", import.meta.url)),
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
        mpcPk,
        signetNotifier,
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
