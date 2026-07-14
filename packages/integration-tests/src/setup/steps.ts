// The ordered setup pipeline: environment check → MPC key derivation →
// compile + deploy (signet, then vault) → derived EVM addresses → MPC
// hand-off printout. Bodies moved verbatim from the original single-file
// suite; each step keeps its skip-if-env-var-set semantics (presence of the
// canonical env var doubles as the skip signal) and mutates the shared env
// accumulator. Run by setup/global-setup.ts in vitest's main process, so no
// `vitest` imports here — the old expect() checks are plain throws.

import { getCliConfig, getUserIdentity } from "@midnight-erc20-vault/cli";
import {
  deriveAccountKeys,
  getDeployConfig,
  getMidnightNodeConfig,
  registerNightForDustGeneration,
  waitForSpendableDust,
  withSyncedWalletFacade,
} from "@midnight-erc20-vault/lib";
import { deriveEvmAddress, formatJubjubPublicKey } from "@sig-net/midnight";
import { deriveMpcKeys, generateMpcRootKey } from "./mpc-keys.ts";
import { deploySignetContract } from "@sig-net/midnight-contract-deploy";
import { deployVault } from "@midnight-erc20-vault/vault-contract";
import { formatEther, formatUnits } from "ethers";
import { PIPELINE_KEYS, requireEnv } from "../e2e-env.ts";
import { getDeployedCode, getEvmChainId, SEPOLIA_USDC_ADDRESS } from "../evm.ts";
import { banner, logSkip } from "../output.ts";
import { assertCommandAvailable, assertHttpReachable } from "../preflight.ts";
import { runRootScript } from "../subprocess.ts";
import { deployTestUsdc, isLocalEvmChain, topUpLocalAccount, WellKnownEvmChainId } from "./local-evm.ts";

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

export async function resolveEvmChain(env: NodeJS.ProcessEnv): Promise<void> {
  const rpcUrl = requireEnv(env, "EVM_RPC_URL");
  let chainId: bigint;
  try {
    chainId = await getEvmChainId(rpcUrl);
  } catch (error) {
    throw new Error(
      `EVM_RPC_URL (${rpcUrl}) is not answering — is the EVM node up?` +
        ` For the local loop it is the \`evm\` docker compose service: \`docker compose up -d\` at the repo root`,
      { cause: error },
    );
  }
  if (env.EVM_CHAIN_ID) {
    console.log(`Found EVM_CHAIN_ID in the environment as ${env.EVM_CHAIN_ID}`);
    if (BigInt(env.EVM_CHAIN_ID) !== chainId) {
      throw new Error(
        `EVM_CHAIN_ID must match the chain EVM_RPC_URL serves (it is sealed into the vault at` +
          ` initialize): the RPC reports ${chainId}, found ${env.EVM_CHAIN_ID}`,
      );
    }
    logSkip("resolve EVM chain id", `EVM_CHAIN_ID is set correctly`);
  } else {
    env.EVM_CHAIN_ID = chainId.toString();
    console.log(`resolved EVM_CHAIN_ID=${env.EVM_CHAIN_ID} from EVM_RPC_URL`);
    console.log(` ➜ sealed into the vault at initialize as CAIP-2 eip155:${env.EVM_CHAIN_ID}`);
    console.log(` ➜ 💡 Set as EVM_CHAIN_ID in the environment to pin it explicitly`);
  }
  // Chain-aware ERC20 defaulting: only Sepolia has a canonical token. On the
  // local dev chain the next step deploys one; on any other chain the next
  // step demands an explicit ERC20_ADDRESS.
  if (!env.ERC20_ADDRESS && chainId === BigInt(WellKnownEvmChainId.Sepolia)) {
    env.ERC20_ADDRESS = SEPOLIA_USDC_ADDRESS;
    console.log(`defaulted ERC20_ADDRESS=${SEPOLIA_USDC_ADDRESS} (canonical Sepolia USDC)`);
  }
}

export async function ensureErc20Deployed(env: NodeJS.ProcessEnv): Promise<void> {
  const rpcUrl = requireEnv(env, "EVM_RPC_URL");
  const chainId = BigInt(requireEnv(env, "EVM_CHAIN_ID"));
  const local = isLocalEvmChain(chainId);
  if (env.ERC20_ADDRESS) {
    // The skip signal is the ON-CHAIN code check, not env presence: a kept
    // ERC20_ADDRESS can outlive a wiped local chain.
    const code = await getDeployedCode(rpcUrl, env.ERC20_ADDRESS);
    if (code !== "0x") {
      logSkip("check/deploy ERC20 token", `ERC20_ADDRESS (${env.ERC20_ADDRESS}) has code on chain ${chainId}`);
      return;
    }
    if (!local) {
      throw new Error(
        `ERC20_ADDRESS (${env.ERC20_ADDRESS}) has no code on chain ${chainId} — wrong address, or wrong EVM_RPC_URL?`,
      );
    }
    console.log(`ERC20_ADDRESS (${env.ERC20_ADDRESS}) has no code — the local chain was wiped; redeploying`);
  } else if (!local) {
    throw new Error(
      `ERC20_ADDRESS is not set and chain ${chainId} is not the local dev chain — set the token to use in the environment`,
    );
  }
  await runRootScript("compile:integration-tests:evm", env, 2 * MINUTE);
  env.ERC20_ADDRESS = await deployTestUsdc(rpcUrl);
  console.log(`deployed a fresh TestUSDC as ERC20_ADDRESS=${env.ERC20_ADDRESS}`);
  console.log(` ➜ the token the deposit/withdraw flows move; open mint funds the derived accounts`);
  console.log(` ➜ 💡 Set as ERC20_ADDRESS in the environment to pin it for the next run`);
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

// The deploys below pay fees in DUST, which only generates on NIGHT
// registered for dust generation — a funded-but-unregistered deployer wallet
// (fresh seed, faucet-funded) would fail the first deploy. Check up front:
// registered already → skip; unregistered NIGHT → register it and wait for a
// spendable dust balance; no NIGHT at all → fail with a funding hint.
export async function ensureDeployerDust(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS && env.MIDNIGHT_VAULT_CONTRACT_ADDRESS) {
    logSkip(
      "deployer dust preflight",
      "both contract addresses are set — no deploys this run, the deployer wallet pays nothing",
    );
    return;
  }
  const deployConfig = getDeployConfig(env);
  const keys = deriveAccountKeys(deployConfig.deployerSeed, deployConfig.midnightNodeConfig.networkId);
  await withSyncedWalletFacade(keys, deployConfig.midnightNodeConfig, async (facade, state) => {
    const registered = await registerNightForDustGeneration(facade, keys, state);
    if (registered === 0) {
      logSkip("register deployer NIGHT for dust generation", "no unregistered NIGHT UTXOs");
    } else {
      console.log(`registered ${registered} deployer NIGHT UTXO(s) for dust generation`);
    }

    // A balance visible right now settles it; otherwise dust may still be
    // generating from a (possibly just-submitted) registration — but only if
    // there is registered NIGHT to generate FROM, so fail fast when the
    // wallet is flat-out unfunded instead of polling into a timeout.
    const dustNow = state.dust.balance(new Date());
    if (dustNow > 0n) {
      console.log(`deployer dust (fee) balance: ${dustNow}`);
      return;
    }
    if (state.unshielded.availableCoins.length === 0) {
      throw new Error(
        "deployer wallet holds neither DUST nor NIGHT — fund it with NIGHT (see DEPLOYER_SEED) before deploying",
      );
    }
    const dust = await waitForSpendableDust(facade);
    console.log(`deployer dust (fee) balance: ${dust}`);
  });
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
  console.log(` ➜ fund it with ETH for gas before running withdrawals (automatic on the local dev chain)`);
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
  console.log(
    ` ➜ FUND IT ON EVM before the deposit test: >= 0.01 ETH (gas) and >= 0.1 USDC (deposit) — automatic on the local dev chain`,
  );
  console.log(` ➜ 💡 Set as EVM_USER_ADDRESS in the environment to skip this step on the next run`);
}

export async function fundLocalEvmAccounts(env: NodeJS.ProcessEnv): Promise<void> {
  const rpcUrl = requireEnv(env, "EVM_RPC_URL");
  const chainId = BigInt(requireEnv(env, "EVM_CHAIN_ID"));
  if (!isLocalEvmChain(chainId)) {
    logSkip(
      "fund derived EVM accounts",
      `chain ${chainId} is not the local dev chain — fund the derived accounts manually (see the printed hints)`,
    );
    return;
  }
  const erc20Address = requireEnv(env, "ERC20_ADDRESS");
  for (const name of ["EVM_USER_ADDRESS", "EVM_VAULT_ADDRESS"] as const) {
    const address = requireEnv(env, name);
    const { ethBalance, tokenBalance } = await topUpLocalAccount(rpcUrl, erc20Address, address);
    console.log(
      `topped up ${name}=${address} to ${formatEther(ethBalance)} ETH and ${formatUnits(tokenBalance, 6)} USDC`,
    );
  }
}

export function printMpcServerConfig(env: NodeJS.ProcessEnv): void {
  const rootKey = env.MPC_ROOT_KEY ?? "(not derived here — already held by the server operator)";
  banner([
    "MPC (fakenet) server configuration — github.com/sig-net/solana-signet-program:",
    "",
    `  MPC_ROOT_KEY=${rootKey}`,
    `  MIDNIGHT_SIGNET_CONTRACT_ADDRESS=${requireEnv(env, "MIDNIGHT_SIGNET_CONTRACT_ADDRESS")}`,
    "  # 💡 The responder DISCOVERS requesters by polling this signet",
    "  #    contract's notification registry — no requester contract list needed.",
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
