// The generic setup steps shared by the caller pipeline: MPC key derivation,
// the deployer dust preflight, signet compile + deploy, and the fakenet
// responder hand-off. Each step keeps its skip-if-env-var-set semantics
// (presence of the canonical env var doubles as the skip signal) and mutates
// the shared env accumulator. Run by setup/caller-global-setup.ts in vitest's
// main process, so no `vitest` imports here — failed checks are plain throws.

import { deploySignetContract } from "@sig-net/midnight-contract-deploy";
import { deriveMidnightResponseKey, formatSecp256k1PublicKey } from "@sig-net/midnight";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { requireEnv } from "../e2e-env.ts";
import { appendRepoDotEnv, loadRepoDotEnv } from "../env-file.ts";
import { logSkip } from "../output.ts";
import { assertCommandAvailable } from "../preflight.ts";
import { REPO_ROOT, runCommand, runRootScript } from "../subprocess.ts";
import { deriveMpcKeys, generateMpcRootKey } from "./mpc-keys.ts";

const MINUTE = 60_000;

export function ensureMpcRootKey(env: NodeJS.ProcessEnv): void {
  if (env.MPC_ROOT_KEY) {
    logSkip("check/derive MPC root key", `MPC_ROOT_KEY is set as ${env.MPC_ROOT_KEY}`);
    return;
  }
  env.MPC_ROOT_KEY = generateMpcRootKey();
  console.log(`generated a fresh MPC_ROOT_KEY=${env.MPC_ROOT_KEY}`);
  console.log(` ➜ seeds MPC key generation`);
  console.log(` ➜ 💡 Set as MPC_ROOT_KEY in the environment to skip this step on the next run`);
}

// Derive MPC keys for setting or checking public keys. Must be called INSIDE
// the steps below — after ensureMpcRootKey has a chance to generate
// MPC_ROOT_KEY.
const mpcKeys = (env: NodeJS.ProcessEnv) => deriveMpcKeys(requireEnv(env, "MPC_ROOT_KEY"));

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

// The signet contract is compiled + deployed FIRST: a client contract seals
// its address as the cross-contract emitter, and the client compile symlinks
// the signet's managed output (its ZK keys) for the cross-contract proof.

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
  console.log(` ➜ the central signet contract on Midnight — records signature requests and MPC responses`);
  console.log(` ➜ 💡 Set as MIDNIGHT_SIGNET_CONTRACT_ADDRESS in the environment to skip compile + deploy on the next run`);
}

/**
 * Derive (or check) the MPC response key for this signet deployment:
 * `MPC_RESPONSE_KEY = f(MPC root key, signet contract address, "midnight
 * response key")`. Caller deploys seal its hash, so this step MUST run after
 * the signet deploy and before any client deploy. The fakenet responder
 * derives the same key from its own MPC_ROOT_KEY +
 * MIDNIGHT_SIGNET_CONTRACT_ADDRESS hand-off, so nothing extra is handed off.
 *
 * @param env - The suite's env accumulator.
 * @throws If a pre-set MPC_RESPONSE_KEY disagrees with the derivation.
 */
export function ensureMpcResponseKey(env: NodeJS.ProcessEnv): void {
  const expected = formatSecp256k1PublicKey(
    deriveMidnightResponseKey(
      requireEnv(env, "MPC_SECP256K1_PUBKEY"),
      requireEnv(env, "MIDNIGHT_SIGNET_CONTRACT_ADDRESS"),
    ),
  );
  if (env.MPC_RESPONSE_KEY) {
    console.log(`Found MPC_RESPONSE_KEY in the environment as ${env.MPC_RESPONSE_KEY}`);
    if (env.MPC_RESPONSE_KEY !== expected) {
      throw new Error(
        `MPC_RESPONSE_KEY should be derived from MPC_ROOT_KEY + MIDNIGHT_SIGNET_CONTRACT_ADDRESS: ` +
          `expected ${expected}, found ${env.MPC_RESPONSE_KEY}`,
      );
    }
    logSkip("check/derive MPC_RESPONSE_KEY public key", `MPC_RESPONSE_KEY is set correctly`);
    return;
  }
  env.MPC_RESPONSE_KEY = expected;
  console.log(`derived a fresh MPC_RESPONSE_KEY=${env.MPC_RESPONSE_KEY}`);
  console.log(` ➜ the MPC's respond-bidirectional key for this signet deployment; client deploys seal its hash`);
  console.log(` ➜ 💡 Set as MPC_RESPONSE_KEY in the environment to skip this step on the next run`);
}

// The fakenet responder hand-off, automated. docker compose interpolates the
// fakenet service's environment from the repo-root .env, so the responder can
// only start once MPC_ROOT_KEY and MIDNIGHT_SIGNET_CONTRACT_ADDRESS are IN
// THAT FILE — the two steps below persist them (append-only) and start the
// container, right after the signet deploy so the responder boots and syncs
// while the (long) caller zk compile runs. Set FAKENET_MANAGED=0 to run the
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
