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

import { hexToBytes, stripHexPrefix } from "@sig-net/midnight";
import {
  assertDeployerFunded,
  buildDeployTransaction,
  contractAddressToReference,
  DeployerWalletKind,
  getDeployConfig,
  withDeployerWallet,
} from "@sig-net/midnight-contract-deploy";
import { envOrUndefined, type TransactionId } from "@sig-net/midnight-wallet";

import { pureCircuits } from "./managed/test-caller-contract/contract/index.js";
import { callerCompiledContract } from "./providers.ts";
import { createCallerPrivateState } from "./witnesses.ts";

/**
 * Resolve the deployer's 32-byte identity secret: `CALLER_DEPLOYER_SECRET_KEY`
 * when set, else the deployer wallet seed (same convention as the erc20-vault
 * example). Its commitment gates the contract's initialise circuit. A remote
 * deployer wallet has no local seed to fall back to, so
 * `CALLER_DEPLOYER_SECRET_KEY` is mandatory there.
 *
 * @param env - The environment to read from.
 * @param fallbackSeed - The deployer wallet seed (32-byte hex), when the
 *   deployer is a local seed wallet.
 * @returns The 32-byte secret key.
 * @throws {Error} If neither source is set, or the resolved value is not
 *   exactly 32 bytes of hex.
 */
export function resolveCallerDeployerSecretKey(
  env: Record<string, string | undefined>,
  fallbackSeed: string | undefined,
): Uint8Array {
  const provided = envOrUndefined(env, "CALLER_DEPLOYER_SECRET_KEY") ?? fallbackSeed;
  if (provided === undefined) {
    throw new Error(
      "CALLER_DEPLOYER_SECRET_KEY is required when the deployer is a remote wallet: " +
        "a remote deployer has no local seed to default the identity secret to.",
    );
  }
  const raw = stripHexPrefix(provided);
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      "the caller deployer identity secret must be exactly 32 bytes of hex (set CALLER_DEPLOYER_SECRET_KEY)",
    );
  }
  return hexToBytes(raw);
}

/** The outcome of a successful caller deployment. */
export interface CallerDeployment {
  /** Address of the deployed caller contract on Midnight. */
  contractAddress: string;
  /** Identifier of the submitted deploy transaction. */
  txId: TransactionId;
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
 * @param env - Environment map providing exactly one of `DEPLOYER_SEED` and
 *   `DEPLOYER_REMOTE_WALLET_URL`, `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` (the
 *   signet contract to seal as the cross-contract emitter), optionally
 *   `CALLER_DEPLOYER_SECRET_KEY` (the identity secret whose commitment gates
 *   initialise; defaults to the deployer seed, so it is mandatory with a
 *   remote deployer wallet) and the shared Midnight node configuration (see
 *   `getMidnightNodeConfig`).
 * @returns The deployed contract address and deploy transaction id.
 * @throws {Error} If `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` is missing/malformed, the
 *   identity secret is malformed, the deployer wallet holds no funds, or
 *   submission fails.
 */
export async function deployCaller(
  env: Record<string, string | undefined> = process.env,
): Promise<CallerDeployment> {
  const deployConfig = getDeployConfig(env);
  const { networkId } = deployConfig.midnightNodeConfig;

  // The deployer's identity commitment, sealed by the constructor: only the
  // holder of the secret may later call initialise (front-run protection for
  // the response-key pin).
  const deployerSecretKey = resolveCallerDeployerSecretKey(
    env,
    deployConfig.deployerWallet.kind === DeployerWalletKind.Seed
      ? deployConfig.deployerWallet.seed
      : undefined,
  );
  const deployerCommitment = pureCircuits.deployerCommitment(deployerSecretKey);

  // The signet contract the caller cross-contract-calls to register signature
  // request notifications — sealed into the caller as the SignetSigner
  // reference, so it must be deployed first.
  const signetContractAddress = env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS?.trim();
  if (!signetContractAddress) {
    throw new Error(
      "MIDNIGHT_SIGNET_CONTRACT_ADDRESS is required (deploy the signet contract first)",
    );
  }
  const signetSigner = contractAddressToReference(signetContractAddress);

  console.log(
    `deploying test-caller-contract to ${networkId} (${deployConfig.midnightNodeConfig.nodeUrl})`,
  );

  const { contractAddress, txId } = await withDeployerWallet(deployConfig, async (wallet) => {
    await assertDeployerFunded(wallet);

    const deployTransaction = await buildDeployTransaction(
      callerCompiledContract,
      networkId,
      wallet.getCoinPublicKey(),
      createCallerPrivateState(deployerSecretKey),
      deployerCommitment,
      signetSigner,
    );
    console.log(`contract address (pre-submit): ${deployTransaction.contractAddress}`);

    const finalized = await wallet.balanceUnprovenTx(deployTransaction.transaction);
    const submittedTxId = await wallet.submitTx(finalized);
    return { contractAddress: deployTransaction.contractAddress, txId: submittedTxId };
  });

  console.log(`submitted deploy tx ${txId}`);
  console.log(`deployed test-caller-contract at ${contractAddress}`);
  console.log("NB: pin the MPC response key with initialise() before verifying responses");

  return { contractAddress, txId };
}
