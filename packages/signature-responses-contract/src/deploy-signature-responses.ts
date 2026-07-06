// Signature-responses deploy flow: builds, balances, proves and submits the
// contract's deploy transaction using the generic plumbing in
// @midnight-erc20-vault/lib. Everything contract-specific lives HERE — which
// for this contract is almost nothing: no constructor args, no witnesses
// (vacant binding), empty private state. Requires `npm run compile:zk`
// output (verifier keys) in src/managed.

import { fileURLToPath } from "node:url";

import {
  assertDeployerFunded,
  buildDeployTransaction,
  deriveAccountKeys,
  getDeployConfig,
  makeVacantCompiledContract,
  submitUnprovenTransaction,
  withSyncedWalletFacade,
  type TransactionIdentifier,
} from "@midnight-erc20-vault/lib";

import { Contract } from "./managed/contract/index.js";
import {
  createSignatureResponsesPrivateState,
  type SignatureResponsesPrivateState,
} from "./witnesses.ts";

/** The outcome of a successful signature-responses deployment. */
export interface SignatureResponsesDeployment {
  /** Address of the deployed signature-responses contract on Midnight. */
  contractAddress: string;
  /** Identifier of the submitted deploy transaction. */
  txId: TransactionIdentifier;
}

/**
 * Deploy the signature-responses contract: read config from `env`, build and
 * prove the deploy transaction and submit it through a synced wallet.
 * Progress is logged to the console. The contract takes no constructor args
 * and posting to it is unauthenticated, so nothing about the deployer is
 * sealed into the contract — any funded wallet can deploy it.
 *
 * @param env - Environment map providing `DEPLOYER_SEED` and lib's Midnight
 *   node configuration.
 * @returns The deployed contract address and deploy transaction id.
 * @throws If the deployer wallet holds no funds or submission fails.
 */
export async function deploySignatureResponses(
  env: Record<string, string | undefined> = process.env,
): Promise<SignatureResponsesDeployment> {
  const deployConfig = getDeployConfig(env);
  const { networkId } = deployConfig.midnightNodeConfig;

  const compiledContract = makeVacantCompiledContract<
    Contract<SignatureResponsesPrivateState>,
    SignatureResponsesPrivateState
  >(
    "signature-responses",
    Contract,
    fileURLToPath(new URL("./managed", import.meta.url)),
  );

  const accountKeys = deriveAccountKeys(deployConfig.deployerSeed, networkId);

  console.log(`deploying signature-responses to ${networkId} (${deployConfig.midnightNodeConfig.nodeUrl})`);

  const { contractAddress, txId } = await withSyncedWalletFacade(
    accountKeys,
    deployConfig.midnightNodeConfig,
    async (facade, state) => {
      assertDeployerFunded(state);

      const deployTransaction = await buildDeployTransaction(
        compiledContract,
        networkId,
        accountKeys.shieldedSecretKeys.coinPublicKey,
        createSignatureResponsesPrivateState(),
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
  console.log(`deployed signature-responses at ${contractAddress}`);

  return { contractAddress, txId };
}
