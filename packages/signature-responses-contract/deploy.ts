// Deploy entrypoint (`npm run deploy`): builds, balances, proves and submits
// the signature-responses deploy transaction using the generic plumbing in
// @midnight-erc20-vault/lib. Everything contract-specific lives HERE: the
// witnesses and the private state (this contract has no constructor args).
// Requires `npm run compile:zk` output (verifier keys) in src/managed.

import { fileURLToPath } from "node:url";

import {
  assertDeployerFunded,
  buildDeployTransaction,
  deriveAccountKeys,
  getDeployConfig,
  makeCompiledContract,
  submitUnprovenTransaction,
  withSyncedWalletFacade,
} from "@midnight-erc20-vault/lib";

import {
  Contract,
  createResponsesPrivateState,
  witnesses,
  type ResponsesPrivateState,
} from "./src/index.ts";

const deployConfig = getDeployConfig();
const { networkId } = deployConfig.midnightNodeConfig;

const compiledContract = makeCompiledContract<Contract<ResponsesPrivateState>, ResponsesPrivateState>(
  "signature-responses",
  Contract,
  witnesses,
  fileURLToPath(new URL("./src/managed", import.meta.url)),
);

const accountKeys = deriveAccountKeys(deployConfig.deployerSeed, networkId);

console.log(`deploying signature-responses to ${networkId} (${deployConfig.midnightNodeConfig.nodeUrl})`);

const { contractAddress, txId } = await withSyncedWalletFacade(
  accountKeys,
  deployConfig.midnightNodeConfig,
  async (facade, state) => {
    assertDeployerFunded(state);

    const deployTransaction = await buildDeployTransaction(
      compiledContract,
      networkId,
      accountKeys.shieldedSecretKeys.coinPublicKey,
      // No witness runs at deploy (argless constructor); the real owner secret
      // only matters for the post-deploy initialise() circuit call.
      createResponsesPrivateState(new Uint8Array(32)),
    );
    console.log(`contract address (pre-submit): ${deployTransaction.contractAddress}`);

    const submittedTxId = await submitUnprovenTransaction(facade, accountKeys, deployTransaction.serializedTransaction);
    return { contractAddress: deployTransaction.contractAddress, txId: submittedTxId };
  },
);

console.log(`submitted deploy tx ${txId}`);
console.log(`deployed signature-responses at ${contractAddress}`);
