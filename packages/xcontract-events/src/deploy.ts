// Deploy flows for the two spike contracts, using the generic plumbing in
// @sig-net/midnight-contract-deploy (same shape as vault-contract / signet-contract
// deploy scripts). Requires `yarn compile:zk` output (verifier keys) in
// src/managed/{token,vault}.
//
// The ORDER matters: the vault (A) is constructed with a REFERENCE to an
// already-deployed token (B). So deploy the token first, then pass its address
// to `deployVault`.

import {
  assertDeployerFunded,
  buildDeployTransaction,
  deriveAccountKeys,
  getDeployConfig,
  submitUnprovenTransaction,
  withSyncedWalletFacade,
  type TransactionIdentifier,
} from "@sig-net/midnight-contract-deploy";

import { tokenCompiledContract, vaultCompiledContract } from "./providers.ts";
import { createTokenPrivateState, createVaultPrivateState } from "./witnesses.ts";

/** The outcome of a successful deployment. */
export interface Deployment {
  /** Address of the deployed contract on Midnight. */
  contractAddress: string;
  /** Identifier of the submitted deploy transaction. */
  txId: TransactionIdentifier;
}

/**
 * A deployed contract's address as the vault constructor wants its `Token`
 * reference: `{ bytes: Uint8Array(32) }`. Accepts hex with or without `0x`.
 */
export function contractAddressToReference(contractAddress: string): { bytes: Uint8Array } {
  const hex = contractAddress.startsWith("0x") ? contractAddress.slice(2) : contractAddress;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`expected a 32-byte hex contract address, got '${contractAddress}'`);
  }
  return { bytes: Uint8Array.from(Buffer.from(hex, "hex")) };
}

/**
 * Deploy the token contract (B, the callee). No constructor args.
 *
 * @param env - Environment map providing `DEPLOYER_SEED` and the shared Midnight node config (see `getMidnightNodeConfig`).
 * @returns The deployed contract address and deploy transaction id.
 */
export async function deployToken(env: Record<string, string | undefined> = process.env): Promise<Deployment> {
  const deployConfig = getDeployConfig(env);
  const { networkId } = deployConfig.midnightNodeConfig;
  const accountKeys = deriveAccountKeys(deployConfig.deployerSeed, networkId);

  console.log(`deploying xc-token to ${networkId} (${deployConfig.midnightNodeConfig.nodeUrl})`);

  const { contractAddress, txId } = await withSyncedWalletFacade(
    accountKeys,
    deployConfig.midnightNodeConfig,
    async (facade, state) => {
      assertDeployerFunded(state);
      const deployTransaction = await buildDeployTransaction(
        tokenCompiledContract,
        networkId,
        accountKeys.shieldedSecretKeys.coinPublicKey,
        createTokenPrivateState(),
      );
      console.log(`token address (pre-submit): ${deployTransaction.contractAddress}`);
      const submittedTxId = await submitUnprovenTransaction(facade, accountKeys, deployTransaction.serializedTransaction);
      return { contractAddress: deployTransaction.contractAddress, txId: submittedTxId };
    },
  );

  console.log(`deployed xc-token at ${contractAddress} (tx ${txId})`);
  return { contractAddress, txId };
}

/**
 * Deploy the vault contract (A, the caller), sealing a reference to an
 * already-deployed token as its constructor argument.
 *
 * @param tokenContractAddress - Address of the token deployed by {@link deployToken}.
 * @param env - Environment map providing `DEPLOYER_SEED` and the shared Midnight node config (see `getMidnightNodeConfig`).
 * @returns The deployed contract address and deploy transaction id.
 */
export async function deployVault(
  tokenContractAddress: string,
  env: Record<string, string | undefined> = process.env,
): Promise<Deployment> {
  const deployConfig = getDeployConfig(env);
  const { networkId } = deployConfig.midnightNodeConfig;
  const accountKeys = deriveAccountKeys(deployConfig.deployerSeed, networkId);
  const tokenReference = contractAddressToReference(tokenContractAddress);

  console.log(`deploying xc-vault to ${networkId}, referencing token ${tokenContractAddress}`);

  const { contractAddress, txId } = await withSyncedWalletFacade(
    accountKeys,
    deployConfig.midnightNodeConfig,
    async (facade, state) => {
      assertDeployerFunded(state);
      const deployTransaction = await buildDeployTransaction(
        vaultCompiledContract,
        networkId,
        accountKeys.shieldedSecretKeys.coinPublicKey,
        createVaultPrivateState(),
        tokenReference,
      );
      console.log(`vault address (pre-submit): ${deployTransaction.contractAddress}`);
      const submittedTxId = await submitUnprovenTransaction(facade, accountKeys, deployTransaction.serializedTransaction);
      return { contractAddress: deployTransaction.contractAddress, txId: submittedTxId };
    },
  );

  console.log(`deployed xc-vault at ${contractAddress} (tx ${txId})`);
  return { contractAddress, txId };
}
