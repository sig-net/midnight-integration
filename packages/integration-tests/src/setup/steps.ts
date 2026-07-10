// The ordered setup pipeline: environment check → MPC key derivation →
// compile + deploy (signet, then vault) → derived EVM addresses → MPC
// hand-off printout. Bodies moved verbatim from the original single-file
// suite; each step keeps its skip-if-env-var-set semantics (presence of the
// canonical env var doubles as the skip signal) and mutates the shared env
// accumulator. Run by setup/global-setup.ts in vitest's main process, so no
// `vitest` imports here — the old expect() checks are plain throws.

import { getCliConfig, getUserIdentity } from "@midnight-erc20-vault/cli";
import { getDeployConfig, getMidnightNodeConfig } from "@midnight-erc20-vault/lib";
import {
  deriveEvmAddress,
  deriveMpcKeys,
  formatJubjubPublicKey,
  generateMpcRootKey,
} from "@midnight-erc20-vault/signet-midnight";
import { deploySignetContract } from "@midnight-erc20-vault/signet-contract";
import { deployVault } from "@midnight-erc20-vault/vault-contract";
import { PIPELINE_KEYS, requireEnv } from "../e2e-env.ts";
import { banner, logSkip } from "../output.ts";
import { assertCommandAvailable, assertHttpReachable } from "../preflight.ts";
import { runRootScript } from "../subprocess.ts";

const MINUTE = 60_000;

export async function assertEnvironment(env: NodeJS.ProcessEnv): Promise<void> {
  const nodeConfig = getMidnightNodeConfig(env);
  await assertHttpReachable("midnight node", new URL("/health", nodeConfig.nodeUrl).href);
  await assertHttpReachable("indexer", nodeConfig.indexerUrl);
  await assertHttpReachable("proof server", nodeConfig.proofServerUrl);
  await assertCommandAvailable("compact", ["--version"]);
  requireEnv(env, "EVM_RPC_URL");

  const deployConfig = getDeployConfig(env);
  const cliConfig = getCliConfig(env);
  console.log(`DEPLOYER_SEED in effect: ${deployConfig.deployerSeed}`);
  console.log(`USER_SEED in effect:     ${cliConfig.userSeed}`);
  console.log();
  console.log(`DEPLOYER_SEED: derives midnight wallet that pays for contract deploys.`);
  console.log(` ➜ seeds midnight wallet that pays for contract deploys.`);
  console.log(`USER_SEED:`);
  console.log(` ➜ seeds midnight wallet that interacts with deployed contracts.`);
  console.log(` ➜ seeds EVM_USER_ADDRESS generation`);
}

export function ensureMpcRootKey(env: NodeJS.ProcessEnv): void {
  if (env.MPC_ROOT_KEY) {
    logSkip("check/derive MPC root key", `MPC_ROOT_KEY is set as ${env.MPC_ROOT_KEY}`);
    return;
  }
  env.MPC_ROOT_KEY = generateMpcRootKey();
  console.log(`generated a fresh MPC_ROOT_KEY=${env.MPC_ROOT_KEY}`);
  console.log(` ➜ seeds MPC key generation`);
  console.log(` ➜ 💡 Set as MPC_ROOT_KEY in the environment to skip this step on the next run`);
  console.log("(printed again in the MPC server configuration step)");
}

// Derive MPC keys for setting or checking public keys. Must be called INSIDE
// the steps below — after ensureMpcRootKey has a chance to generate
// MPC_ROOT_KEY.
const mpcKeys = (env: NodeJS.ProcessEnv) => deriveMpcKeys(requireEnv(env, "MPC_ROOT_KEY"));

export function ensureMpcJubjubPk(env: NodeJS.ProcessEnv): void {
  const expectedMPCJubjubPK = formatJubjubPublicKey(mpcKeys(env).jubjubPoint);
  if (env.MPC_JUBJUB_PK) {
    console.log(`Found MPC_JUBJUB_PK in the environment as ${env.MPC_JUBJUB_PK}`);
    if (env.MPC_JUBJUB_PK !== expectedMPCJubjubPK) {
      throw new Error(
        `MPC_JUBJUB_PK should be derived from MPC_ROOT_KEY: expected ${expectedMPCJubjubPK}, found ${env.MPC_JUBJUB_PK}`,
      );
    }
    logSkip("check/derive MPC_JUBJUB_PK public key", `MPC_JUBJUB_PK is set correctly`);
    return;
  }
  env.MPC_JUBJUB_PK = expectedMPCJubjubPK;
  console.log(`generated a fresh MPC_JUBJUB_PK=${env.MPC_JUBJUB_PK}`);
  console.log(` ➜ used by contracts to validate signatures`);
  console.log(` ➜ 💡 Set as MPC_JUBJUB_PK in the environment to skip this step on the next run`);
}

export function ensureMpcSecp256k1Pubkey(env: NodeJS.ProcessEnv): void {
  const expectedSECP256k1CompressedPubkey = mpcKeys(env).secp256k1CompressedPubkey;
  if (env.MPC_SECP256K1_PUBKEY) {
    console.log(`Found MPC_SECP256K1_PUBKEY in the environment as ${env.MPC_SECP256K1_PUBKEY}`);
    if (env.MPC_SECP256K1_PUBKEY !== expectedSECP256k1CompressedPubkey) {
      throw new Error(
        `MPC_SECP256K1_PUBKEY should be derived from MPC_ROOT_KEY: expected ${expectedSECP256k1CompressedPubkey}, found ${env.MPC_SECP256K1_PUBKEY}`,
      );
    }
    logSkip("check/derive MPC_SECP256K1_PUBKEY public key", `MPC_SECP256K1_PUBKEY is set correctly`);
    return;
  }
  env.MPC_SECP256K1_PUBKEY = expectedSECP256k1CompressedPubkey;
  console.log(`generated a fresh MPC_SECP256K1_PUBKEY=${env.MPC_SECP256K1_PUBKEY}`);
  console.log(` ➜ used by contracts to validate signatures`);
  console.log(` ➜ 💡 Set as MPC_SECP256K1_PUBKEY in the environment to skip this step on the next run`);
}

// The signet contract is compiled + deployed FIRST: the vault seals its
// address as the cross-contract emitter, and the vault compile symlinks the
// signet's managed output (its ZK keys) for the cross-contract proof.

export async function compileSignetContract(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS) {
    logSkip("compile:signet-contract:zk", `MIDNIGHT_SIGNET_CONTRACT_ADDRESS is set (${env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS})`);
    return;
  }
  await runRootScript("compile:signet-contract:zk", env, 14 * MINUTE);
}

export async function deploySignetContractStep(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS) {
    logSkip("deploy:signet-contract", `MIDNIGHT_SIGNET_CONTRACT_ADDRESS is set (${env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS})`);
    return;
  }
  const { contractAddress } = await deploySignetContract(env);
  env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS = contractAddress;
  console.log(`deployed a fresh MIDNIGHT_SIGNET_CONTRACT_ADDRESS=${contractAddress}`);
  console.log(` ➜ the central signet contract on Midnight — records signature requests and authenticated MPC responses`);
  console.log(` ➜ 💡 Set as MIDNIGHT_SIGNET_CONTRACT_ADDRESS in the environment to skip compile + deploy on the next run`);
}

export async function compileVaultContract(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.MIDNIGHT_VAULT_CONTRACT_ADDRESS) {
    logSkip("compile:vault-contract:zk", `MIDNIGHT_VAULT_CONTRACT_ADDRESS is set (${env.MIDNIGHT_VAULT_CONTRACT_ADDRESS})`);
    return;
  }
  await runRootScript("compile:vault-contract:zk", env, 14 * MINUTE);
}

export async function deployVaultContractStep(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.MIDNIGHT_VAULT_CONTRACT_ADDRESS) {
    logSkip("deploy:vault-contract", `MIDNIGHT_VAULT_CONTRACT_ADDRESS is set (${env.MIDNIGHT_VAULT_CONTRACT_ADDRESS})`);
    return;
  }
  const { contractAddress } = await deployVault(env);
  env.MIDNIGHT_VAULT_CONTRACT_ADDRESS = contractAddress;
  console.log(`deployed a fresh MIDNIGHT_VAULT_CONTRACT_ADDRESS=${contractAddress}`);
  console.log(` ➜ the vault contract on Midnight — holds deposits and authorizes withdrawals`);
  console.log(` ➜ 💡 Set as MIDNIGHT_VAULT_CONTRACT_ADDRESS in the environment to skip compile + deploy on the next run`);
}

export function ensureVaultEvmAddress(env: NodeJS.ProcessEnv): void {
  const expectedAddress = deriveEvmAddress(
    requireEnv(env, "MPC_SECP256K1_PUBKEY"),
    requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
    "vault",
  );
  if (env.EVM_VAULT_ADDRESS) {
    console.log(`Found EVM_VAULT_ADDRESS in the environment as ${env.EVM_VAULT_ADDRESS}`);
    if (env.EVM_VAULT_ADDRESS !== expectedAddress) {
      throw new Error(
        `EVM_VAULT_ADDRESS should be derived from MPC_SECP256K1_PUBKEY + vault contract address: expected ${expectedAddress}, found ${env.EVM_VAULT_ADDRESS}`,
      );
    }
    logSkip("check/derive vault EVM address", `EVM_VAULT_ADDRESS is set correctly`);
    return;
  }
  env.EVM_VAULT_ADDRESS = expectedAddress;
  console.log(`derived a fresh EVM_VAULT_ADDRESS=${expectedAddress}`);
  console.log(` ➜ the vault's own EVM account (path "vault")`);
  console.log(` ➜ fund it with ETH for gas before running withdrawals`);
  console.log(` ➜ 💡 Set as EVM_VAULT_ADDRESS in the environment to skip this step on the next run`);
}

export function ensureUserEvmAddress(env: NodeJS.ProcessEnv): void {
  const identity = getUserIdentity(getCliConfig(env));
  const expectedAddress = deriveEvmAddress(
    requireEnv(env, "MPC_SECP256K1_PUBKEY"),
    requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
    identity.commitmentHex,
  );
  if (env.EVM_USER_ADDRESS) {
    console.log(`Found EVM_USER_ADDRESS in the environment as ${env.EVM_USER_ADDRESS}`);
    if (env.EVM_USER_ADDRESS !== expectedAddress) {
      throw new Error(
        `EVM_USER_ADDRESS should be derived from MPC_SECP256K1_PUBKEY + vault contract + user identity: expected ${expectedAddress}, found ${env.EVM_USER_ADDRESS}`,
      );
    }
    logSkip("check/derive user EVM address", `EVM_USER_ADDRESS is set correctly`);
    return;
  }
  env.EVM_USER_ADDRESS = expectedAddress;
  console.log(`derived a fresh EVM_USER_ADDRESS=${expectedAddress}`);
  console.log(` ➜ the user's derived EVM account (path = identity commitment hex)`);
  console.log(` ➜ FUND IT ON EVM before the deposit test: >= 0.01 ETH (gas) and >= 0.1 USDC (deposit)`);
  console.log(` ➜ 💡 Set as EVM_USER_ADDRESS in the environment to skip this step on the next run`);
}

export function printMpcServerConfig(env: NodeJS.ProcessEnv): void {
  const rootKey = env.MPC_ROOT_KEY ?? "(not derived here — already held by the server operator)";
  banner([
    "MPC (fakenet) server configuration — github.com/sig-net/solana-signet-program:",
    "",
    `  MPC_ROOT_KEY=${rootKey}`,
    `  MIDNIGHT_SIGNET_CONTRACT_ADDRESS=${requireEnv(env, "MIDNIGHT_SIGNET_CONTRACT_ADDRESS")}`,
    "  # 💡 The responder now DISCOVERS requesters by watching this signet",
    "  #    contract's events — no requester contract list needed.",
    "",
    "Set those in the server's .env, then START THE SERVER: `yarn response`",
    "in the solana-signet-program repo. The e2e deposit/withdraw flows need",
    "it running.",
    "",
    "Minimal .env block for THIS suite:",
    "",
    ...PIPELINE_KEYS.map((key) => `  ${key}=${env[key] ?? ""}`),
    `  EVM_RPC_URL=${env.EVM_RPC_URL ?? ""}`,
  ]);
}
