// Deploy entrypoint (`npm run deploy`): builds, balances, proves and submits
// the vault's deploy transaction using the generic plumbing in
// @midnight-erc20-vault/lib. Everything contract-specific lives HERE:
// the constructor arg (deployerCommitment), the witnesses, and the private
// state. Requires `npm run compile:zk` output (verifier keys) in src/managed.

import { fileURLToPath } from "node:url";

import {
  assertDeployerFunded,
  buildDeployTransaction,
  deriveAccountKeys,
  getDeployConfig,
  makeCompiledContract,
  parseIdentitySecretKey,
  submitUnprovenTransaction,
  withSyncedWalletFacade,
} from "@midnight-erc20-vault/lib";

import {
  Contract,
  createVaultPrivateState,
  pureCircuits,
  witnesses,
  type VaultPrivateState,
} from "./src/index.ts";

const deployConfig = getDeployConfig();
const { networkId } = deployConfig.midnightNodeConfig;

// The deployer identity: its commitment is sealed into the contract as
// `deployer`, and the same secret must later answer the `callerSecretKey`
// witness to pass `initialize`'s gate.
const secretKey = parseIdentitySecretKey("VAULT_DEPLOYER_SECRET_KEY", process.env, deployConfig.deployerSeed);
const deployerCommitment = pureCircuits.userCommitment(secretKey);

const compiledContract = makeCompiledContract<Contract<VaultPrivateState>, VaultPrivateState>(
  "erc20-vault",
  Contract,
  witnesses,
  fileURLToPath(new URL("./src/managed", import.meta.url)),
);

const accountKeys = deriveAccountKeys(deployConfig.deployerSeed, networkId);

console.log(`deploying erc20-vault to ${networkId} (${deployConfig.midnightNodeConfig.nodeUrl})`);

const { contractAddress, txId } = await withSyncedWalletFacade(
  accountKeys,
  deployConfig.midnightNodeConfig,
  async (facade, state) => {
    assertDeployerFunded(state);

    const deployTransaction = await buildDeployTransaction(
      compiledContract,
      networkId,
      accountKeys.shieldedSecretKeys.coinPublicKey,
      createVaultPrivateState(secretKey),
      deployerCommitment,
    );
    console.log(`contract address (pre-submit): ${deployTransaction.contractAddress}`);

    const submittedTxId = await submitUnprovenTransaction(facade, accountKeys, deployTransaction.serializedTransaction);
    return { contractAddress: deployTransaction.contractAddress, txId: submittedTxId };
  },
);

console.log(`submitted deploy tx ${txId}`);
console.log(`deployed erc20-vault at ${contractAddress}`);
