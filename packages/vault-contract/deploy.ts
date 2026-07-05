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
  parseSeed,
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

/**
 * Resolve the vault deployer's 32-byte identity secret: `VAULT_DEPLOYER_SECRET_KEY`
 * (hex, optional 0x prefix) when set, else the bytes of the deployer wallet seed.
 * Its commitment is sealed into the contract as `deployer`, and the same secret
 * must later answer the `callerSecretKey` witness to pass `initialize`'s gate.
 *
 * @param env - The environment to read from.
 * @param deployerSeed - The funding wallet's seed (hex or mnemonic), the fallback identity.
 * @returns The 32-byte secret key.
 * @throws If `VAULT_DEPLOYER_SECRET_KEY` is set but not 32 bytes of hex, or if it is
 * unset and the deployer seed does not parse to exactly 32 bytes (e.g. a mnemonic).
 */
function getVaultDeployerSecretKey(env: Record<string, string | undefined>, deployerSeed: string): Uint8Array {
  const raw = env.VAULT_DEPLOYER_SECRET_KEY?.trim();
  if (raw) {
    const hex = raw.replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error("VAULT_DEPLOYER_SECRET_KEY must be exactly 32 bytes of hex");
    }
    return Uint8Array.from(hex.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)));
  }
  const { seed } = parseSeed(deployerSeed);
  if (seed.length !== 32) {
    throw new Error(
      `DEPLOYER_SEED parses to ${seed.length} bytes; the vault deployer identity needs exactly 32. ` +
        "Set VAULT_DEPLOYER_SECRET_KEY explicitly.",
    );
  }
  return seed;
}

const deployConfig = getDeployConfig();
const { networkId } = deployConfig.midnightNodeConfig;

const secretKey = getVaultDeployerSecretKey(process.env, deployConfig.deployerSeed);
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
