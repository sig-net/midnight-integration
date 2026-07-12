// Signet-contract deploy flow: builds, balances, proves and submits the
// contract's deploy transaction using the generic plumbing in
// @midnight-erc20-vault/lib. Everything contract-specific lives HERE: the
// MPC attestation key constructor arg and the (empty) private state.
// Requires `yarn compile:zk` output (verifier keys) in src/managed.

import {
  assertDeployerFunded,
  buildDeployTransaction,
  deriveAccountKeys,
  getDeployConfig,
  submitUnprovenTransaction,
  withSyncedWalletFacade,
  type TransactionIdentifier,
} from "@midnight-erc20-vault/lib";
import { parseJubjubPublicKey } from "@midnight-erc20-vault/signet-midnight";

import { signetContractCompiledContract } from "./providers.ts";
import { createSignetContractPrivateState } from "./witnesses.ts";

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
 * logged to the console. The one constructor argument is the MPC attestation
 * key (`MPC_JUBJUB_PK`, "x,y" decimal or 0x-hex field coordinates),
 * whose hash the contract seals — remote execution responses must be signed
 * by it. Any funded wallet can deploy; nothing about the deployer is sealed.
 *
 * @param env - Environment map providing `DEPLOYER_SEED`,
 *   `MPC_JUBJUB_PK` and lib's Midnight node configuration.
 * @returns The deployed contract address and deploy transaction id.
 * @throws If `MPC_JUBJUB_PK` is missing/malformed, the deployer
 *   wallet holds no funds, or submission fails.
 */
export async function deploySignetContract(
  env: Record<string, string | undefined> = process.env,
): Promise<SignetContractDeployment> {
  const deployConfig = getDeployConfig(env);
  const { networkId } = deployConfig.midnightNodeConfig;

  const mpcPkRaw = env.MPC_JUBJUB_PK?.trim();
  if (!mpcPkRaw) {
    throw new Error("MPC_JUBJUB_PK is required (the MPC attestation key, as \"x,y\")");
  }
  const mpcPk = parseJubjubPublicKey(mpcPkRaw);

  const accountKeys = deriveAccountKeys(deployConfig.deployerSeed, networkId);

  console.log(`deploying signet-contract to ${networkId} (${deployConfig.midnightNodeConfig.nodeUrl})`);
  console.log(`mpc attestation key: x=${mpcPk.x} y=${mpcPk.y}`);

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
        mpcPk,
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
