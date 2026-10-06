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
  type AccountFunding,
  assertRootFunded,
  deriveWalletAddresses,
  fundChildFromRoot,
  generateHexSeed,
  GENESIS_MINT_WALLET_SEED,
  getFaucetUrl,
  getMidnightNodeConfig,
  isFeeReady,
  isLocalStandaloneNetwork,
  readAccountFunding,
  type WalletAddresses,
  type WalletRegistry,
  WalletUnfundedError,
} from "@sig-net/midnight-contract-deploy";

import { requireEnv } from "../e2e-env.ts";
import { appendRepoDotEnv } from "../env-file.ts";
import { banner, logSkip } from "../output.ts";
import { explainDustSpendRejection } from "./steps.ts";

/**
 * One wallet role: its display label, the env var holding its seed, and the
 * shares of root's NIGHT the automatic split gives it (see {@link fundingShare}).
 */
export interface RoleWallet {
  readonly label: string;
  readonly envVar: string;
  readonly shares: bigint;
}

/** The funding root. Does no test work: it holds NIGHT, pays the roles out and keeps one share for its own fees. */
const ROOT: RoleWallet = { label: "root", envVar: "ROOT_SEED", shares: 1n };

/**
 * The role wallets funded from root, in setup order: `deployer` deploys the
 * contracts, `invoker` drives the caller contract's circuits, `mpc responder`
 * is the fakenet responder's fee-paying wallet (MPC_RESPONDER_SEED).
 * The deployer weighs three shares: it pays one transaction per deploy,
 * where every other role pays one or two.
 */
const CHILDREN: readonly RoleWallet[] = [
  { label: "deployer", envVar: "DEPLOYER_SEED", shares: 3n },
  { label: "invoker", envVar: "INVOKER_SEED", shares: 1n },
  { label: "mpc responder", envVar: "MPC_RESPONDER_SEED", shares: 1n },
];

/**
 * Format a wallet's three addresses as banner lines.
 *
 * @param label - The wallet's role name.
 * @param addresses - The wallet's unshielded, shielded and dust addresses.
 * @returns The banner lines, ready to print.
 */
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
    appendRepoDotEnv(
      generated,
      "integration-tests setup: generated wallet seeds (root/deployer/invoker/mpc responder)",
    );
  }
}

/**
 * Log a funded wallet's pass line with its balances and NIGHT address.
 *
 * @param label - The wallet's role name.
 * @param funding - The wallet's measured NIGHT and DUST balances.
 */
function logFundedPass(label: string, funding: AccountFunding): void {
  console.log(
    `${label} funding OK — NIGHT ${String(funding.night)}, DUST ${String(funding.dust)} (${funding.addresses.unshielded})`,
  );
}

/**
 * One share of root's NIGHT: the balance divided across the shares of the
 * children that need funding plus root's own, so the split adapts to however
 * much the faucet delivered.
 *
 * @param rootNight - Root's NIGHT balance in base units.
 * @param unfunded - The children that still need funding.
 * @returns The NIGHT one share is worth, in base units.
 */
export function fundingShare(rootNight: bigint, unfunded: readonly RoleWallet[]): bigint {
  return rootNight / unfunded.reduce((sum, role) => sum + role.shares, ROOT.shares);
}

/**
 * The NIGHT to transfer to one child. `FUND_CHILD_NIGHT` (base units) pins it
 * for every child. Otherwise the child receives its shares of root's balance.
 *
 * @param env - The environment to read `FUND_CHILD_NIGHT` from.
 * @param share - The NIGHT one share is worth (see {@link fundingShare}).
 * @param child - The child to fund.
 * @returns The NIGHT to send the child, in base units.
 * @throws {Error} If `FUND_CHILD_NIGHT` is set but is not a non-negative integer.
 */
export function perChildAmount(env: NodeJS.ProcessEnv, share: bigint, child: RoleWallet): bigint {
  const override = env.FUND_CHILD_NIGHT?.trim();
  if (override) {
    if (!/^\d+$/.test(override)) {
      throw new Error(
        `FUND_CHILD_NIGHT must be a non-negative integer in NIGHT base units; got "${override}".`,
      );
    }
    return BigInt(override);
  }
  return share * child.shares;
}

/**
 * Fund the role wallets from root. Preflight root first: on a deployed network
 * whose root is not yet faucet-funded this STOPS the run (re-throwing
 * {@link WalletUnfundedError}) after printing the NIGHT address + faucet URL.
 * Then each child that is already fee-ready passes; each that is not is topped
 * up from root and registered for dust. Idempotent across reruns: funded
 * wallets are only checked.
 *
 * @param env - The suite's env accumulator (seeds already resolved).
 * @param wallets - The pipeline's registry: every role wallet syncs once here and stays open.
 * @throws {WalletUnfundedError} To halt the run when root needs faucet funding.
 */
export async function ensureWalletsFunded(
  env: NodeJS.ProcessEnv,
  wallets: WalletRegistry,
): Promise<void> {
  const faucetUrl = getFaucetUrl(env, wallets.config.networkId);

  const root = await preflightRoot(wallets, requireEnv(env, ROOT.envVar), faucetUrl);
  logFundedPass("root", root);

  const checked = [];
  for (const child of CHILDREN) {
    checked.push({
      child,
      funding: await readAccountFunding(wallets, requireEnv(env, child.envVar), child.label),
    });
  }
  const unfunded = checked.filter(({ funding }) => !isFeeReady(funding)).map(({ child }) => child);
  const share = fundingShare(root.night, unfunded);
  if (unfunded.length > 0) {
    console.log(
      `funding plan: root holds ${String(root.night)} NIGHT, one share is ${String(share)}, root keeps ${String(ROOT.shares)}` +
        (env.FUND_CHILD_NIGHT ? " (FUND_CHILD_NIGHT pins every child). " : ". ") +
        unfunded
          .map(
            (child) =>
              `${child.label}: ${String(perChildAmount(env, share, child))} (${String(child.shares)} share(s))`,
          )
          .join(", "),
    );
  }

  for (const { child, funding } of checked) {
    if (isFeeReady(funding)) {
      logFundedPass(child.label, funding);
      continue;
    }
    const amount = perChildAmount(env, share, child);
    console.log(
      `${child.label} not fee-ready (NIGHT ${String(funding.night)}, DUST ${String(funding.dust)}) — funding ${String(amount)} from root`,
    );
    const funded = await explainDustSpendRejection(`fund ${child.label}`, () =>
      fundChildFromRoot(
        wallets,
        requireEnv(env, ROOT.envVar),
        requireEnv(env, child.envVar),
        child.label,
        amount,
      ),
    );
    logFundedPass(child.label, funded);
  }
}

/**
 * Root preflight, surfacing {@link WalletUnfundedError}'s stop message before rethrowing.
 *
 * @param wallets - The registry holding the root wallet.
 * @param rootSeed - The root wallet's seed.
 * @param faucetUrl - The network's faucet, included in the stop message.
 * @returns Root's measured funding, once it passes.
 * @throws {WalletUnfundedError} When root holds no spendable funds.
 */
async function preflightRoot(
  wallets: WalletRegistry,
  rootSeed: string,
  faucetUrl: string | undefined,
): Promise<AccountFunding> {
  try {
    return await assertRootFunded(wallets, rootSeed, faucetUrl);
  } catch (error) {
    if (error instanceof WalletUnfundedError) {
      banner(["ROOT WALLET NEEDS FUNDING — stopping here", "", ...error.message.split("\n")]);
    }
    throw error;
  }
}
