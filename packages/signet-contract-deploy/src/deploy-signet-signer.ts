// Signet-signer deploy flow: the shared protocol-contract flow over the
// signet signer's compiled assets. The contract has no constructor
// arguments (it only emits unauthenticated events: verification is the
// reader's job) and an empty private state. Requires the contract package's
// compiled assets to carry keys (its published dist/managed always does; an
// in-repo checkout needs `yarn compile:zk`).

import {
  type ContractDeployEstimate,
  type ContractDeployment,
  deployProtocolContract,
  type DeployTransactionBuilder,
  estimateProtocolContractDeploy,
} from "./deploy-protocol-contract.ts";
import { buildDeployTransaction } from "./plumbing/deploy.ts";
import type { WalletRegistry } from "./plumbing/wallet.ts";
import {
  createSignetSignerPrivateState,
  signetSignerCompiledContract,
} from "./signet-signer-binding.ts";

/**
 * Deploy the signet signer through {@link deployProtocolContract}, which
 * logs `deployed signet-signer at <address>` on success.
 *
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
export async function deploySignetSigner(
  env: Record<string, string | undefined> = process.env,
  wallets?: WalletRegistry,
): Promise<ContractDeployment> {
  return deployProtocolContract("signet-signer", buildSignetSignerDeployTransaction, env, wallets);
}

/**
 * Price the signet signer's deploy through {@link estimateProtocolContractDeploy},
 * which logs the deployer's balances, the deploy fee and the NIGHT that
 * generates it, and submits nothing.
 *
 * @param env - Environment map providing `DEPLOYER_SEED` and the shared
 *   Midnight node configuration (see `getMidnightNodeConfig`).
 * @param wallets - A registry to take the deployer wallet from. Without one,
 *   a private registry is opened for this estimate and closed after it.
 * @returns The estimate.
 * @throws {Error} If the deployer wallet cannot be synced or the transaction cannot be built or priced.
 */
export async function estimateSignetSignerDeploy(
  env: Record<string, string | undefined> = process.env,
  wallets?: WalletRegistry,
): Promise<ContractDeployEstimate> {
  return estimateProtocolContractDeploy(
    "signet-signer",
    buildSignetSignerDeployTransaction,
    env,
    wallets,
  );
}

const buildSignetSignerDeployTransaction: DeployTransactionBuilder = (
  networkId,
  coinPublicKeyHex,
) =>
  buildDeployTransaction(
    signetSignerCompiledContract,
    networkId,
    coinPublicKeyHex,
    createSignetSignerPrivateState(),
  );
