// Caller deploy flow: builds, balances, proves and submits the caller's
// deploy transaction using the generic plumbing in
// @sig-net/midnight-contract-deploy. Everything contract-specific lives HERE:
// the constructor args (the MPC attestation key + the signet contract
// reference) and the (empty) private state. Requires `yarn compile:zk`
// output (verifier keys) in src/managed.

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
import { parseSecp256k1PublicKey } from "@sig-net/midnight";

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
 * logged to the console.
 *
 * The MPC attestation key (`MPC_SECP256K1_PUBKEY`, compressed or uncompressed
 * 0x-hex) is sealed as `mpcPubKeyHash` — verifyResponse accepts only ECDSA
 * attestations signed by it. The signet contract address is sealed as the
 * cross-contract notification target.
 *
 * @param env - Environment map providing `DEPLOYER_SEED`, `MPC_SECP256K1_PUBKEY`,
 *   `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` (the signet contract to seal as the
 *   cross-contract emitter) and the shared Midnight node configuration (see
 *   `getMidnightNodeConfig`).
 * @returns The deployed contract address and deploy transaction id.
 * @throws If `MPC_SECP256K1_PUBKEY` or `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` is
 *   missing/malformed, the deployer wallet holds no funds, or submission fails.
 */
export async function deployCaller(env: Record<string, string | undefined> = process.env): Promise<CallerDeployment> {
  const deployConfig = getDeployConfig(env);
  const { networkId } = deployConfig.midnightNodeConfig;

  const mpcPkRaw = env.MPC_SECP256K1_PUBKEY?.trim();
  if (!mpcPkRaw) {
    throw new Error('MPC_SECP256K1_PUBKEY is required (the MPC attestation key, as compressed/uncompressed 0x-hex)');
  }
  const mpcPk = parseSecp256k1PublicKey(mpcPkRaw);

  // The signet contract the caller cross-contract-calls to register signature
  // request notifications — sealed into the caller as the SignetNotifier
  // reference, so it must be deployed first.
  const signetContractAddress = env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS?.trim();
  if (!signetContractAddress) {
    throw new Error("MIDNIGHT_SIGNET_CONTRACT_ADDRESS is required (deploy the signet contract first)");
  }
  const signetNotifier = contractAddressToReference(signetContractAddress);

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
  console.log(`deployed signet-caller at ${contractAddress}`);

  return { contractAddress, txId };
}
