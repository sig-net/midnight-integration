// Caller deploy flow: builds, balances, proves and submits the caller's
// deploy transaction using the generic plumbing in
// @sig-net/midnight-contract-deploy. Everything contract-specific lives HERE:
// the constructor arg (the signet contract reference) and the (empty)
// private state. Requires `yarn compile:zk` output (verifier keys) in
// src/managed.
//
// The MPC response key is NOT a deploy input: it is derived from THIS
// contract's address (which only exists once the deploy transaction is
// built), so it is pinned afterwards via the contract's one-shot
// `initialise` circuit — see the integration-tests flow.

import {
  assertDeployerFunded,
  buildDeployTransaction,
  contractAddressToReference,
  deriveAccountKeys,
  getDeployConfig,
  submitUnprovenTransaction,
  withSyncedWalletFacade,
  type TransactionIdentifier,
} from "@sig-net/midnight-contract-deploy";

import { callerCompiledContract } from "./providers.ts";
import { createCallerPrivateState } from "./witnesses.ts";

/** The outcome of a successful caller deployment. */
export interface CallerDeployment {
  /** Address of the deployed caller contract on Midnight. */
  contractAddress: string;
  /** Identifier of the submitted deploy transaction. */
  txId: TransactionIdentifier;
}

/**
 * Deploy the signet caller contract: read config from `env`, build/prove the
 * deploy transaction and submit it through a synced wallet. Progress is
 * logged to the console. The one constructor argument is the signet contract
 * address, sealed as the cross-contract notification target. The MPC
 * response key for the freshly deployed contract must then be pinned with a
 * separate `initialise` call (derive it from the MPC root public key + the
 * NEW contract address + the fixed path "midnight response key").
 *
 * @param env - Environment map providing `DEPLOYER_SEED`,
 *   `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` (the signet contract to seal as the
 *   cross-contract emitter) and the shared Midnight node configuration (see
 *   `getMidnightNodeConfig`).
 * @returns The deployed contract address and deploy transaction id.
 * @throws If `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` is missing/malformed, the
 *   deployer wallet holds no funds, or submission fails.
 */
export async function deployCaller(env: Record<string, string | undefined> = process.env): Promise<CallerDeployment> {
  const deployConfig = getDeployConfig(env);
  const { networkId } = deployConfig.midnightNodeConfig;

  // The signet contract the caller cross-contract-calls to register signature
  // request notifications — sealed into the caller as the SignetSigner
  // reference, so it must be deployed first.
  const signetContractAddress = env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS?.trim();
  if (!signetContractAddress) {
    throw new Error("MIDNIGHT_SIGNET_CONTRACT_ADDRESS is required (deploy the signet contract first)");
  }
  const signetSigner = contractAddressToReference(signetContractAddress);

  const accountKeys = deriveAccountKeys(deployConfig.deployerSeed, networkId);

  console.log(`deploying signet-caller to ${networkId} (${deployConfig.midnightNodeConfig.nodeUrl})`);

  const { contractAddress, txId } = await withSyncedWalletFacade(
    accountKeys,
    deployConfig.midnightNodeConfig,
    async (facade, state) => {
      assertDeployerFunded(state);

      const deployTransaction = await buildDeployTransaction(
        callerCompiledContract,
        networkId,
        accountKeys.shieldedSecretKeys.coinPublicKey,
        createCallerPrivateState(),
        signetSigner,
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
  console.log(`deployed signet-caller at ${contractAddress}`);
  console.log("NB: pin the MPC response key with initialise() before verifying responses");

  return { contractAddress, txId };
}
