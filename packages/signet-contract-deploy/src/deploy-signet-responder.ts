// Signet-responder deploy flow: the shared protocol-contract flow over the
// responder's compiled assets. Like the signet signer, the responder has no
// constructor arguments and an empty private state. Requires its compiled
// assets to carry keys (its published dist/managed always does; an in-repo
// checkout needs `yarn compile:signet-responder:zk`).

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
  createSignetResponderPrivateState,
  signetResponderCompiledContract,
} from "./signet-responder-binding.ts";

/**
 * Deploy the signet responder through {@link deployProtocolContract}, which
 * logs `deployed signet-responder at <address>` on success.
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
export async function deploySignetResponder(
  env: Record<string, string | undefined> = process.env,
  wallets?: WalletRegistry,
): Promise<ContractDeployment> {
  return deployProtocolContract(
    "signet-responder",
    buildSignetResponderDeployTransaction,
    env,
    wallets,
  );
}

/**
 * Price the signet responder's deploy through {@link estimateProtocolContractDeploy},
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
export async function estimateSignetResponderDeploy(
  env: Record<string, string | undefined> = process.env,
  wallets?: WalletRegistry,
): Promise<ContractDeployEstimate> {
  return estimateProtocolContractDeploy(
    "signet-responder",
    buildSignetResponderDeployTransaction,
    env,
    wallets,
  );
}

const buildSignetResponderDeployTransaction: DeployTransactionBuilder = (
  networkId,
  coinPublicKeyHex,
) =>
  buildDeployTransaction(
    signetResponderCompiledContract,
    networkId,
    coinPublicKeyHex,
    createSignetResponderPrivateState(),
  );
