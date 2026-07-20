// Signet-contract deploy flow: builds, balances, proves and submits the
// contract's deploy transaction using the generic plumbing in ./plumbing.
// Everything contract-specific lives HERE: the MPC attestation key
// constructor arg and the (empty) private state. Requires the contract
// package's compiled assets to carry keys (its published dist/managed
// always does; an in-repo checkout needs `yarn compile:zk`).

import { parseSecp256k1PublicKey } from "@sig-net/midnight";
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
 * logged to the console. The one constructor argument is the MPC attestation
 * key (`MPC_SECP256K1_PUBKEY`, compressed or uncompressed 0x-hex), whose hash
 * the contract seals — remote execution attestations must be ECDSA-signed by
 * it. Any funded wallet can deploy; nothing about the deployer is sealed.
 *
 * @param env - Environment map providing `DEPLOYER_SEED`,
 *   `MPC_SECP256K1_PUBKEY` and the shared Midnight node configuration (see `getMidnightNodeConfig`).
 * @returns The deployed contract address and deploy transaction id.
 * @throws If `MPC_SECP256K1_PUBKEY` is missing/malformed, the deployer
 *   wallet holds no funds, or submission fails.
 */
export async function deploySignetContract(
  env: Record<string, string | undefined> = process.env,
): Promise<SignetContractDeployment> {
  const deployConfig = getDeployConfig(env);
  const { networkId } = deployConfig.midnightNodeConfig;

  const mpcPkRaw = env.MPC_SECP256K1_PUBKEY?.trim();
  if (!mpcPkRaw) {
    throw new Error("MPC_SECP256K1_PUBKEY is required (the MPC attestation key, as compressed/uncompressed 0x-hex)");
  }
  const mpcPk = parseSecp256k1PublicKey(mpcPkRaw);

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
