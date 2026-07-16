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
} from "@sig-net/midnight-contract-deploy";
import { deriveEvmAddress, formatJubjubPublicKey } from "@sig-net/midnight";
import { deriveMpcKeys, generateMpcRootKey } from "./mpc-keys.ts";
import { deploySignetContract } from "@sig-net/midnight-contract-deploy";
import { deployVault } from "@midnight-erc20-vault/vault-contract";
import { formatEther, formatUnits } from "ethers";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { PIPELINE_KEYS, requireEnv } from "../e2e-env.ts";
import { appendRepoDotEnv, loadRepoDotEnv } from "../env-file.ts";
import { getDeployedCode, getEvmChainId, SEPOLIA_USDC_ADDRESS } from "../evm.ts";
import { banner, logSkip } from "../output.ts";
import { assertCommandAvailable, assertHttpReachable } from "../preflight.ts";
import { REPO_ROOT, runCommand, runRootScript } from "../subprocess.ts";
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

/**
 * The deploys pay fees in DUST, which only generates on NIGHT registered for
 * dust generation — a funded-but-unregistered deployer wallet (fresh seed,
 * faucet-funded) would fail the first deploy. Check up front: registered
 * already → skip; unregistered NIGHT → register it and wait for a spendable
 * dust balance; no NIGHT at all → fail with a funding hint.
 *
 * @param env - The suite's env accumulator.
 * @param contractAddressEnvVars - The env-var names of every contract address
 *   the calling pipeline deploys; when ALL are already set the run deploys
 *   nothing and the preflight skips.
 * @throws If the deployer wallet holds neither DUST nor NIGHT.
 */
export async function ensureDeployerDust(
  env: NodeJS.ProcessEnv,
  contractAddressEnvVars: readonly string[],
): Promise<void> {
  if (contractAddressEnvVars.every((name) => env[name])) {
    logSkip(
      "deployer dust preflight",
      `all contract addresses are set (${contractAddressEnvVars.join(", ")}) — no deploys this run, the deployer wallet pays nothing`,
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

/**
 * True when the CI zk-key cache contract is in force: `TRUST_PREBUILT_ZK_KEYS=1`
 * AND the given managed keys directory already holds prover keys. Local runs
 * never set the variable — key PRESENCE alone is not FRESHNESS (a circuit
 * edit leaves stale keys behind; locally the contract-address env vars are
 * the skip signal instead). Only a cache keyed on the contract sources can
 * assert freshness, so trusting prebuilt keys is an explicit opt-in by the
 * environment that restored them (see .github/workflows/ci.yml).
 *
 * @param env - The suite's env accumulator.
 * @param keysDir - The managed keys directory, relative to the repo root.
 * @returns Whether the zk compile step may be skipped.
 */
export function trustsPrebuiltZkKeys(env: NodeJS.ProcessEnv, keysDir: string): boolean {
  if (env.TRUST_PREBUILT_ZK_KEYS !== "1") {
    return false;
  }
  try {
    return readdirSync(join(REPO_ROOT, keysDir)).some((file) => file.endsWith(".prover"));
  } catch {
    return false; // cache miss — the directory does not exist yet
  }
}

export async function compileSignetContract(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS) {
    logSkip("compile:signet-contract:zk", `MIDNIGHT_SIGNET_CONTRACT_ADDRESS is set (${env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS})`);
    return;
  }
  if (trustsPrebuiltZkKeys(env, "packages/signet-contract/src/managed/keys")) {
    logSkip(
      "compile:signet-contract:zk",
      "TRUST_PREBUILT_ZK_KEYS=1 and prover keys are present (restored from a cache keyed on the contract sources)",
    );
    return;
  }
  await runRootScript("compile:signet-contract:zk", env, 14 * MINUTE);
}

/**
 * Run a deploy, retrying while the deployer wallet cannot yet pay the fee.
 * On a freshly started dev chain DUST generates block by block from the
 * genesis NIGHT, so the first deploy can race the chain's first minutes —
 * `Wallet.InsufficientFunds` ("could not balance dust") is transient there.
 * A genuinely unfunded wallet fails fast in {@link ensureDeployerDust}
 * instead, so the bounded retry here cannot mask real underfunding.
 *
 * @param what - Step label for the retry log lines.
 * @param deploy - The deploy call to (re)attempt.
 * @returns Whatever `deploy` resolves to.
 * @throws The last error when attempts are exhausted, or immediately for
 *   any error that is not the transient insufficient-dust failure.
 */
export async function retryDeployWhileDustGenerates<T>(what: string, deploy: () => Promise<T>): Promise<T> {
  const RETRY_DELAY_MS = 15_000;
  const MAX_ATTEMPTS = 24; // ~6 minutes — a young dev chain generates plenty by then
  for (let attempt = 1; ; attempt++) {
    try {
      return await deploy();
    } catch (error) {
      const message = String(error);
      const transient = message.includes("InsufficientFunds") || message.includes("could not balance dust");
      if (!transient || attempt >= MAX_ATTEMPTS) {
        throw error;
      }
      console.log(
        `${what}: deployer cannot pay the fee yet (dust still generating on a young chain?)` +
          ` — retrying in ${RETRY_DELAY_MS / 1000}s (attempt ${attempt}/${MAX_ATTEMPTS})`,
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

export async function deploySignetContractStep(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS) {
    logSkip("deploy:signet-contract", `MIDNIGHT_SIGNET_CONTRACT_ADDRESS is set (${env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS})`);
    return;
  }
  const { contractAddress } = await retryDeployWhileDustGenerates("deploy:signet-contract", () =>
    deploySignetContract(env),
  );
  env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS = contractAddress;
  console.log(`deployed a fresh MIDNIGHT_SIGNET_CONTRACT_ADDRESS=${contractAddress}`);
  console.log(` ➜ the central signet contract on Midnight — records signature requests and authenticated MPC responses`);
  console.log(` ➜ 💡 Set as MIDNIGHT_SIGNET_CONTRACT_ADDRESS in the environment to skip compile + deploy on the next run`);
}

// The fakenet responder hand-off, automated. docker compose interpolates the
// fakenet service's environment from the repo-root .env, so the responder can
// only start once MPC_ROOT_KEY and MIDNIGHT_SIGNET_CONTRACT_ADDRESS are IN
// THAT FILE — the two steps below persist them (append-only) and start the
// container, right after the signet deploy so the responder boots and syncs
// while the (long) vault zk compile runs. Set FAKENET_MANAGED=0 to run the
// responder yourself (e.g. `yarn response` in a solana-signet-program
// checkout for responder development) — both steps then skip.

/** The env keys docker compose interpolates into the fakenet service — the hand-off payload. */
const FAKENET_HANDOFF_KEYS = ["MPC_ROOT_KEY", "MIDNIGHT_SIGNET_CONTRACT_ADDRESS"] as const;

/**
 * Whether {@link persistFakenetHandoffToDotEnv} appended hand-off values to
 * `.env` THIS run. Read by {@link startFakenetResponder} to decide between a
 * plain `up -d` (values were already in the file — a running responder is
 * already correct) and `--force-recreate` (values newly landed — the
 * responder must re-read `.env` and reset its private state).
 */
let fakenetHandoffAppended = false;

/**
 * Persist the fakenet hand-off values to the repo-root `.env`, append-only.
 * Each key is checked against the FILE (not the process env): already there
 * with the run's value → nothing to do; absent → appended under a provenance
 * comment; present with a DIFFERENT value → hard error, because docker
 * compose reads the file and would start the responder against the stale
 * value while this run uses another.
 *
 * @param env - The suite's env accumulator (holds the run's values).
 * @throws If a hand-off key in `.env` conflicts with the run's value.
 */
export function persistFakenetHandoffToDotEnv(env: NodeJS.ProcessEnv): void {
  if (env.FAKENET_MANAGED === "0") {
    logSkip("persist fakenet hand-off to .env", "FAKENET_MANAGED=0 — you manage the responder and its config yourself");
    return;
  }
  const fileEnv = loadRepoDotEnv();
  const toAppend: Record<string, string> = {};
  for (const key of FAKENET_HANDOFF_KEYS) {
    const runValue = requireEnv(env, key);
    const fileValue = fileEnv[key];
    if (fileValue === runValue) {
      continue;
    }
    if (fileValue !== undefined) {
      throw new Error(
        `${key} conflicts: this run uses ${runValue} (from your shell environment) but .env holds ${fileValue}.` +
          ` docker compose reads .env, so the fakenet responder would start against the stale value.` +
          ` Reconcile the two (usually: update .env and unset the shell override), then rerun.`,
      );
    }
    toAppend[key] = runValue;
  }
  if (Object.keys(toAppend).length === 0) {
    logSkip("persist fakenet hand-off to .env", `${FAKENET_HANDOFF_KEYS.join(" and ")} are already in .env`);
    return;
  }
  appendRepoDotEnv(toAppend, `appended by the integration-tests setup (${new Date().toISOString()}) — fakenet responder hand-off`);
  fakenetHandoffAppended = true;
  for (const [key, value] of Object.entries(toAppend)) {
    console.log(`appended ${key}=${value} to .env`);
  }
  console.log(` ➜ docker compose interpolates the fakenet service's environment from .env`);
  console.log(` ➜ append-only: existing .env lines are never modified`);
}

/**
 * Start (or recreate) the fakenet responder compose service. Recreates the
 * container only when {@link persistFakenetHandoffToDotEnv} appended values
 * this run — a recreate re-reads `.env` and resets the responder's private
 * state, which is required after a fresh key/deploy and disruptive otherwise.
 * Container readiness here means `running`; hard readiness is confirmed by
 * the first signature poll in the flows (poll loops tolerate startup lag).
 *
 * @param env - The suite's env accumulator (passed to docker compose, whose
 *   interpolation lets process env win over `.env` — same values by the time
 *   this runs, so the two sources agree).
 * @throws If docker compose fails or the container is not `running` after `up`.
 */
export async function startFakenetResponder(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.FAKENET_MANAGED === "0") {
    logSkip(
      "start fakenet responder",
      "FAKENET_MANAGED=0 — start it yourself: `docker compose --profile fakenet up -d --force-recreate fakenet`," +
        " or `yarn response` in a solana-signet-program checkout (responder development)",
    );
    return;
  }
  await assertCommandAvailable("docker", ["compose", "version"]);
  console.log(
    fakenetHandoffAppended
      ? "hand-off values newly landed in .env — recreating the responder so it re-reads .env and resets its private state"
      : "hand-off values were already in .env — plain up: a running responder is left untouched",
  );
  const args = ["compose", "--profile", "fakenet", "up", "-d", ...(fakenetHandoffAppended ? ["--force-recreate"] : []), "fakenet"];
  console.log(`$ docker ${args.join(" ")}   (cwd: repo root)`);
  await runCommand("docker", args, env, 10 * MINUTE);
  const status = (await runCommand("docker", ["inspect", "-f", "{{.State.Status}}", "fakenet-responder"], env, MINUTE)).trim();
  if (status !== "running") {
    throw new Error(`fakenet-responder container is "${status}", expected "running" — check \`docker logs fakenet-responder\``);
  }
  console.log("fakenet-responder container is running");
  console.log(" ➜ watch it: `docker logs -f fakenet-responder` — healthy startup prints");
  console.log('   "MidnightMonitor: polling signet contract registry at <signet address>"');
}

export async function compileVaultContract(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.MIDNIGHT_VAULT_CONTRACT_ADDRESS) {
    logSkip("compile:vault-contract:zk", `MIDNIGHT_VAULT_CONTRACT_ADDRESS is set (${env.MIDNIGHT_VAULT_CONTRACT_ADDRESS})`);
    return;
  }
  if (trustsPrebuiltZkKeys(env, "packages/vault-contract/src/managed/erc20-vault/keys")) {
    logSkip(
      "compile:vault-contract:zk",
      "TRUST_PREBUILT_ZK_KEYS=1 and prover keys are present (restored from a cache keyed on the contract sources)",
    );
    return;
  }
  await runRootScript("compile:vault-contract:zk", env, 14 * MINUTE);
}

export async function deployVaultContractStep(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.MIDNIGHT_VAULT_CONTRACT_ADDRESS) {
    logSkip("deploy:vault-contract", `MIDNIGHT_VAULT_CONTRACT_ADDRESS is set (${env.MIDNIGHT_VAULT_CONTRACT_ADDRESS})`);
    return;
  }
  const { contractAddress } = await retryDeployWhileDustGenerates("deploy:vault-contract", () => deployVault(env));
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
  const managed = env.FAKENET_MANAGED !== "0";
  banner([
    "MPC (fakenet) responder configuration:",
    "",
    `  MPC_ROOT_KEY=${rootKey}`,
    `  MIDNIGHT_SIGNET_CONTRACT_ADDRESS=${requireEnv(env, "MIDNIGHT_SIGNET_CONTRACT_ADDRESS")}`,
    "  # 💡 The responder DISCOVERS requesters by polling this signet",
    "  #    contract's notification registry — no requester contract list needed.",
    "",
    ...(managed
      ? [
          "The setup already persisted these to .env (append-only) and started",
          "the responder container — see the two hand-off steps above. Watch it",
          "with `docker logs -f fakenet-responder`; recreate it manually with",
          "`docker compose --profile fakenet up -d --force-recreate fakenet`.",
          "(Set FAKENET_MANAGED=0 to run the responder yourself, e.g.",
          "`yarn response` in a checkout of sig-net/solana-signet-program.)",
        ]
      : [
          "FAKENET_MANAGED=0 — make sure those two are in THIS repo's .env",
          "(docker compose reads it), then START THE RESPONDER container:",
          "",
          "  docker compose --profile fakenet up -d --force-recreate fakenet",
          "",
          "(--force-recreate re-reads .env and resets the responder's private state",
          "after a redeploy; watch it with `docker logs -f fakenet-responder`.",
          "Fallback for responder development: `yarn response` in a checkout of",
          "github.com/sig-net/solana-signet-program.) The e2e deposit/withdraw",
          "flows need it running.",
        ]),
    "",
    "Minimal .env block for THIS suite:",
    "",
    ...PIPELINE_KEYS.map((key) => `  ${key}=${env[key] ?? ""}`),
    `  VITE_TEST_EVM_RPC_URL=${env.EVM_RPC_URL ?? ""}`,
  ]);
}
