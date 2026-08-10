// Signet-contract deploy flow: builds, balances, proves and submits the
// contract's deploy transaction through a connected wallet. Everything
// contract-specific lives HERE: the (empty) private state. The contract has
// no constructor arguments (it only emits unauthenticated events:
// verification is the reader's job). Requires the contract package's
// compiled assets to carry keys (its published dist/managed always does; an
// in-repo checkout needs `yarn compile:zk`).

import type { TransactionId } from "@sig-net/midnight-wallet";

import {
  assertDeployerFunded,
  buildDeployTransaction,
  getDeployConfig,
  withDeployerWallet,
} from "./plumbing/deploy.ts";
import {
  createSignetContractPrivateState,
  signetContractCompiledContract,
} from "./signet-contract-binding.ts";

/** The outcome of a successful signet-contract deployment. */
export interface SignetContractDeployment {
  /** Address of the deployed signet contract on Midnight. */
  contractAddress: string;
  /** Identifier of the submitted deploy transaction. */
  txId: TransactionId;
}

/**
 * Deploy the signet contract: read config from `env`, build the deploy
 * transaction, then balance, prove and submit it through the configured
 * deployer wallet (a seed-built local wallet or a hosted remote one).
 * Progress is logged to the console. The contract takes no constructor
 * arguments. Any funded wallet can deploy; nothing about the deployer is
 * sealed.
 *
 * @param env - Environment map providing exactly one of `DEPLOYER_SEED` and
 *   `DEPLOYER_REMOTE_WALLET_URL`, plus the shared Midnight node
 *   configuration (see `getMidnightNodeConfig`).
 * @returns The deployed contract address and deploy transaction id.
 * @throws {Error} If the deployer wallet holds no funds or submission fails.
 */
export async function deploySignetContract(
  env: Record<string, string | undefined> = process.env,
): Promise<SignetContractDeployment> {
  const deployConfig = getDeployConfig(env);
  const { networkId } = deployConfig.midnightNodeConfig;

  console.log(
    `deploying signet-contract to ${networkId} (${deployConfig.midnightNodeConfig.nodeUrl})`,
  );

  const { contractAddress, txId } = await withDeployerWallet(deployConfig, async (wallet) => {
    await assertDeployerFunded(wallet);

    const deployTransaction = await buildDeployTransaction(
      signetContractCompiledContract,
      networkId,
      wallet.getCoinPublicKey(),
      createSignetContractPrivateState(),
    );
    console.log(`contract address (pre-submit): ${deployTransaction.contractAddress}`);

    const finalized = await wallet.balanceUnprovenTx(deployTransaction.transaction);
    const submittedTxId = await wallet.submitTx(finalized);
    return { contractAddress: deployTransaction.contractAddress, txId: submittedTxId };
  });

  console.log(`submitted deploy tx ${txId}`);
  console.log(`deployed signet-contract at ${contractAddress}`);

  return { contractAddress, txId };
}
