// The multi-wallet seed + funding phase: ONE root wallet funds three role
// wallets (deployer, invoker, mpc responder). Each role's seed is read from
// .env when present, otherwise generated, persisted (append-only), and its
// addresses printed. Root does no test work; it only holds funds and pays the
// roles out.
//
// - undeployed: root defaults to the pre-funded genesis mint wallet, so the
//   roles are funded from genesis at runtime.
// - deployed (e.g. stagenet): root is a generated (or supplied) seed; its
//   NIGHT address must be faucet-funded. The first run generates the seeds and
//   STOPS at the root preflight printing that address; once funded, a rerun
//   funds the roles and proceeds.
//
// No `vitest` imports here — this runs in vitest's main process (globalSetup).

import {
  assertRootFunded,
  deriveWalletAddresses,
  fundChildFromRoot,
  getFaucetUrl,
  GENESIS_MINT_WALLET_SEED,
  generateHexSeed,
  getMidnightNodeConfig,
  isFeeReady,
  isLocalStandaloneNetwork,
  readAccountFunding,
  RootUnfundedError,
  type AccountFunding,
  type MidnightNodeConfig,
  type WalletAddresses,
} from "@sig-net/midnight-contract-deploy";

import { requireEnv } from "../e2e-env.ts";
import { appendRepoDotEnv } from "../env-file.ts";
import { banner, logSkip } from "../output.ts";

/** One wallet role: its display label and the env var holding its seed. */
interface RoleWallet {
  readonly label: string;
  readonly envVar: string;
}

/** The funding root. Does no test work; holds NIGHT and pays the roles out. */
const ROOT: RoleWallet = { label: "root", envVar: "ROOT_SEED" };

/**
 * The role wallets funded from root, in setup order: `deployer` deploys the
 * contracts, `invoker` drives the caller contract's circuits, `mpc responder`
 * is the fakenet responder's fee-paying wallet ({@link MPC_RESPONDER wallet}).
 */
const CHILDREN: readonly RoleWallet[] = [
  { label: "deployer", envVar: "DEPLOYER_SEED" },
  { label: "invoker", envVar: "INVOKER_SEED" },
  { label: "mpc responder", envVar: "MPC_RESPONDER_SEED" },
];

/** Format a wallet's three addresses as banner lines. */
function walletAddressLines(label: string, addresses: WalletAddresses): string[] {
  return [
    `${label} wallet addresses:`,
    `  NIGHT (unshielded): ${addresses.unshielded}`,
    `  shielded:           ${addresses.shielded}`,
    `  dust:               ${addresses.dust}`,
  ];
}

/**
 * Resolve every wallet seed: reuse the one in `.env` when present, otherwise
 * generate it (root on the local chain defaults to the genesis mint wallet),
 * populate the env accumulator, persist the newly-created seeds to `.env`
 * (append-only), and print each wallet's addresses. After this, ROOT_SEED,
 * DEPLOYER_SEED, INVOKER_SEED and MPC_RESPONDER_SEED are all set in `env`.
 *
 * @param env - The suite's env accumulator (mutated with the resolved seeds).
 */
export function ensureWalletSeeds(env: NodeJS.ProcessEnv): void {
  const config = getMidnightNodeConfig(env);
  const generated: Record<string, string> = {};

  for (const role of [ROOT, ...CHILDREN]) {
    const existing = env[role.envVar]?.trim();
    let seed: string;
    if (existing) {
      seed = existing;
      logSkip(`resolve ${role.label} seed`, `${role.envVar} is set — reusing it`);
    } else {
      seed =
        role === ROOT && isLocalStandaloneNetwork(config.networkId)
          ? GENESIS_MINT_WALLET_SEED
          : generateHexSeed();
      env[role.envVar] = seed;
      generated[role.envVar] = seed;
      console.log(`generated ${role.label} seed -> ${role.envVar} (persisted to .env)`);
    }
    banner(walletAddressLines(role.label, deriveWalletAddresses(seed, config)));
  }

  if (Object.keys(generated).length > 0) {
    appendRepoDotEnv(generated, "integration-tests setup: generated wallet seeds (root/deployer/invoker/mpc responder)");
  }
}

/** Log a funded wallet's pass line with its balances and NIGHT address. */
function logFundedPass(label: string, funding: AccountFunding): void {
  console.log(
    `${label} funding OK — NIGHT ${funding.night}, DUST ${funding.dust} (${funding.addresses.unshielded})`,
  );
}

/**
 * The per-child NIGHT transfer amount. `FUND_CHILD_NIGHT` (base units) pins it;
 * otherwise root's balance is split evenly across the children that need
 * funding, keeping one share in root (for its own transfer fees), so the split
 * adapts to however much the faucet delivered.
 */
function perChildAmount(env: NodeJS.ProcessEnv, rootNight: bigint, unfundedCount: number): bigint {
  const override = env.FUND_CHILD_NIGHT?.trim();
  if (override) {
    if (!/^\d+$/.test(override)) {
      throw new Error(`FUND_CHILD_NIGHT must be a non-negative integer in NIGHT base units; got "${env.FUND_CHILD_NIGHT}".`);
    }
    return BigInt(override);
  }
  return rootNight / BigInt(unfundedCount + 1);
}

/**
 * Fund the role wallets from root. Preflight root first: on a deployed network
 * whose root is not yet faucet-funded this STOPS the run (re-throwing
 * {@link RootUnfundedError}) after printing the NIGHT address + faucet URL.
 * Then each child that is already fee-ready passes; each that is not is topped
 * up from root and registered for dust. Idempotent across reruns: funded
 * wallets are only checked.
 *
 * @param env - The suite's env accumulator (seeds already resolved).
 * @throws {@link RootUnfundedError} to halt the run when root needs faucet funding.
 */
export async function ensureWalletsFunded(env: NodeJS.ProcessEnv): Promise<void> {
  const config = getMidnightNodeConfig(env);
  // Faucet URLs are not published in this repo; MIDNIGHT_FAUCET_URL
  // supplies one for the underfunded-root hint (optional).
  const faucetUrl = getFaucetUrl(env, config.networkId);

  const root = await preflightRoot(config, requireEnv(env, ROOT.envVar), faucetUrl);
  logFundedPass("root", root);

  const checked = [];
  for (const child of CHILDREN) {
    checked.push({ child, funding: await readAccountFunding(config, requireEnv(env, child.envVar)) });
  }
  const unfundedCount = checked.filter((entry) => !isFeeReady(entry.funding)).length;
  const amount = perChildAmount(env, root.night, unfundedCount);

  for (const { child, funding } of checked) {
    if (isFeeReady(funding)) {
      logFundedPass(child.label, funding);
      continue;
    }
    console.log(`${child.label} not fee-ready (NIGHT ${funding.night}, DUST ${funding.dust}) — funding ${amount} from root`);
    const funded = await fundChildFromRoot(config, requireEnv(env, ROOT.envVar), requireEnv(env, child.envVar), amount);
    logFundedPass(child.label, funded);
  }
}

/** Root preflight, surfacing {@link RootUnfundedError}'s stop message before rethrowing. */
async function preflightRoot(
  config: MidnightNodeConfig,
  rootSeed: string,
  faucetUrl: string | undefined,
): Promise<AccountFunding> {
  try {
    return await assertRootFunded(config, rootSeed, faucetUrl);
  } catch (error) {
    if (error instanceof RootUnfundedError) {
      banner(["ROOT WALLET NEEDS FUNDING — stopping here", "", ...error.message.split("\n")]);
    }
    throw error;
  }
}
