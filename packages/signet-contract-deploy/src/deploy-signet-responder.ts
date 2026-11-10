// Signet-responder deploy flow: the shared protocol-contract flow over the
// responder's compiled assets. Like the signet signer, the responder has no
// constructor arguments and an empty private state. Requires its compiled
// assets to carry keys (its published dist/managed always does; an in-repo
// checkout needs `yarn compile:signet-responder:zk`).

import { type ContractDeployment, deployProtocolContract } from "./deploy-protocol-contract.ts";
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
    (networkId, coinPublicKeyHex) =>
      buildDeployTransaction(
        signetResponderCompiledContract,
        networkId,
        coinPublicKeyHex,
        createSignetResponderPrivateState(),
      ),
    env,
    wallets,
  );
}
