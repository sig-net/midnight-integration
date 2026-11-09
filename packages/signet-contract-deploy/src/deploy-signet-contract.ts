// Signet-contract deploy flow: the shared protocol-contract flow over the
// signet contract's compiled assets. The contract has no constructor
// arguments (it only emits unauthenticated events: verification is the
// reader's job) and an empty private state. Requires the contract package's
// compiled assets to carry keys (its published dist/managed always does; an
// in-repo checkout needs `yarn compile:zk`).

import { type ContractDeployment, deployProtocolContract } from "./deploy-protocol-contract.ts";
import { buildDeployTransaction } from "./plumbing/deploy.ts";
import type { WalletRegistry } from "./plumbing/wallet.ts";
import {
  createSignetContractPrivateState,
  signetContractCompiledContract,
} from "./signet-contract-binding.ts";

/**
 * Deploy the signet contract through {@link deployProtocolContract}, which
 * logs `deployed signet-contract at <address>` on success.
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
export async function deploySignetContract(
  env: Record<string, string | undefined> = process.env,
  wallets?: WalletRegistry,
): Promise<ContractDeployment> {
  return deployProtocolContract(
    "signet-contract",
    (networkId, coinPublicKeyHex) =>
      buildDeployTransaction(
        signetContractCompiledContract,
        networkId,
        coinPublicKeyHex,
        createSignetContractPrivateState(),
      ),
    env,
    wallets,
  );
}
