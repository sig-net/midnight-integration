// The claimant-is-not-the-recipient e2e flow: claim takes an OPTIONAL
// mint recipient, so the depositor (the only identity allowed to claim) can
// direct the freshly minted shielded vault tokens to a DIFFERENT wallet's
// Zswap coin public key. This flow proves that end to end: a deposit round
// trip claims with `recipient` set to a second wallet, and that wallet —
// built from its own seed and synced from chain — must see the minted coin in
// its shielded balance for the vault token's color. The mint itself is
// shielded, so the recipient wallet's balance delta (plus the request's
// public removal from the vault ledger) IS the observable outcome.
//
// The recipient wallet never spends anything (the session wallet pays all
// fees), so it needs no funding — only a seed. Its balance assertions are
// DELTA-based: the fixed seed may accumulate tokens across runs.
//
// The claimed tokens strand on the recipient wallet (this flow does not
// withdraw them), so the deposited ERC20 would strand on the vault's EVM
// account run after run — the final step drains it back to EVM_USER_ADDRESS
// with the fakenet-only vault key (see src/fakenet-vault-account.ts), the
// same fund-cycling move the failure-refund flow uses. Run AFTER
// tests/happy-day-e2e.test.ts (FILE_ORDER): initialize lives there. Recovery
// from a run that died mid-flow (proof-server OOM): rerun this file with
// DEPOSIT_CLAIMANT_NOT_CALLER_DEPOSIT_REQUEST_ID set to the id the failed
// run printed.
//
// Tests drive the vault THROUGH the cli's exported command functions
// (AGENTS.md: orchestration lives in the cli, never in tests).

import {
  ERC20_TRANSFER_GAS_LIMIT,
  ERC20_TRANSFER_MAX_FEE_PER_GAS,
  readVaultLedger,
  requireConfigValue,
  vaultTokenType,
  type ShieldedTokenRecipient,
} from "@midnight-erc20-vault/cli";
import {
  deriveAccountKeys,
  getMidnightNodeConfig,
  withSyncedWalletFacade,
} from "@midnight-erc20-vault/lib";
import { requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import { formatEther, parseEther, parseUnits } from "ethers";
import { afterAll, describe, expect, it } from "vitest";
import { requireEnv as requireEnvOf } from "../src/e2e-env.ts";
import { getErc20Balance, getEthBalance } from "../src/evm.ts";
import { drainVaultErc20 } from "../src/fakenet-vault-account.ts";
import { injectE2eEnv, installFlowHooks } from "../src/flow-hooks.ts";
import { runDepositRoundTrip } from "../src/flows/deposit.ts";
import { banner, logSkip } from "../src/output.ts";
import { createE2eSession } from "../src/session.ts";

const MINUTE = 60_000;

/**
 * The setup-populated env accumulator: repo-root `.env` overlaid with the
 * real environment (which wins), plus every value the globalSetup pipeline
 * derived or deployed. Empty when RUN_INTEGRATION_TESTS is unset — the suite
 * below skips before reading it.
 */
const env = injectE2eEnv();

/** Assert a setup step populated `name`, failing with a pointed message. */
const requireEnv = (name: string): string => requireEnvOf(env, name);

// Wallet facade + cli context + MPC-style reader shared by every test in
// this file (lazily built, so the offline path never touches the network);
// stopped once in afterAll.
const session = createE2eSession(env);

// One deposit's worth of shielded vault tokens is minted straight to the
// alternate recipient — 0.1 USDC, the funding preflight's minimum.
const DEPOSIT_AMOUNT = parseUnits("0.1", 6);

// The alternate recipient's wallet seed: a fixed constant, deliberately
// different from USER_SEED (which defaults to the genesis seed `00…01`), so
// the mint provably lands on a wallet that is NOT the claimant's. The wallet
// only receives — it never signs or pays fees — so the seed needs no funding
// and no identity secret.
const RECIPIENT_SEED = "0000000000000000000000000000000000000000000000000000000000000042";

/** The alternate recipient's shielded key pair, derived from its fixed seed. */
const recipientKeys = (): ShieldedTokenRecipient => {
  const { shieldedSecretKeys } = deriveAccountKeys(RECIPIENT_SEED, getMidnightNodeConfig(env).networkId);
  return {
    coinPublicKey: shieldedSecretKeys.coinPublicKey,
    encryptionPublicKey: shieldedSecretKeys.encryptionPublicKey,
  };
};

/**
 * Build a FRESH wallet for the alternate recipient, sync it from chain, and
 * read its shielded balance of the vault token for `ERC20_ADDRESS`. A fresh
 * facade per read (rather than a shared session) is the point: discovering
 * the coin from public chain data alone is what proves the mint reached the
 * recipient.
 */
const readRecipientVaultTokenBalance = async (): Promise<bigint> => {
  const nodeConfig = getMidnightNodeConfig(env);
  const keys = deriveAccountKeys(RECIPIENT_SEED, nodeConfig.networkId);
  const color = vaultTokenType(requireEnv("ERC20_ADDRESS"), requireEnv("MIDNIGHT_VAULT_CONTRACT_ADDRESS"));
  return withSyncedWalletFacade(keys, nodeConfig, async (_facade, state) => state.shielded.balances[color] ?? 0n);
};

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault deposit → claim to a recipient that is not the caller e2e", () => {
  installFlowHooks();

  afterAll(async () => {
    await session.stop();
  });

  it(
    "funding preflight: user EVM account holds the deposit minimums, vault EVM account holds the drain gas",
    async () => {
      const rpcUrl = requireEnv("EVM_RPC_URL");
      const userAddress = requireEnv("EVM_USER_ADDRESS");
      const vaultAddress = requireEnv("EVM_VAULT_ADDRESS");
      const erc20Address = requireEnv("ERC20_ADDRESS");

      // Same minimums as the happy-day deposit leg: the user's derived
      // account pays the sweep gas and supplies the deposited ERC20.
      const userEth = await getEthBalance(rpcUrl, userAddress);
      console.log(`${userAddress} ETH balance: ${userEth} wei`);
      expect(userEth, `fund ${userAddress} with >= 0.009 ETH on EVM`).toBeGreaterThanOrEqual(
        parseEther("0.009"),
      );
      const { balance, decimals } = await getErc20Balance(rpcUrl, erc20Address, userAddress);
      console.log(`${userAddress} balance on ${erc20Address}: ${balance} (decimals ${decimals})`);
      expect(balance, `fund ${userAddress} with >= 0.1 of ERC20 ${erc20Address} on EVM`).toBeGreaterThanOrEqual(
        DEPOSIT_AMOUNT,
      );

      // The vault's derived account sends the fund-cycling drain itself:
      // require the fee-cap budget of one ERC20 transfer.
      const gasBudget = ERC20_TRANSFER_GAS_LIMIT * ERC20_TRANSFER_MAX_FEE_PER_GAS;
      const vaultEth = await getEthBalance(rpcUrl, vaultAddress);
      console.log(`${vaultAddress} ETH balance: ${vaultEth} wei (drain gas budget: ${gasBudget} wei)`);
      expect(
        vaultEth,
        `fund the vault's derived account ${vaultAddress} with >= ${formatEther(gasBudget)} ETH on EVM`,
      ).toBeGreaterThanOrEqual(gasBudget);
    },
    MINUTE,
  );

  it(
    "vault-initialized preflight: the vault contract is initialized (read-only)",
    async () => {
      const context = await session.cliContext();
      const vaultContractAddress = requireConfigValue(context.config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
      const state = await readVaultLedger(context, vaultContractAddress);
      expect(
        state.initialized,
        "vault is not initialized — run tests/happy-day-e2e.test.ts first (or initialize the vault)",
      ).toBe(1n);
    },
    5 * MINUTE,
  );

  // Populated by the balance-before step and compared after the claim; the
  // recipient's fixed seed may hold tokens from prior runs, so assertions
  // are delta-based.
  let recipientBalanceBefore: bigint;

  it(
    "arrange: sync the alternate recipient's wallet and record its shielded vault-token balance",
    async () => {
      const recipient = recipientKeys();
      recipientBalanceBefore = await readRecipientVaultTokenBalance();

      banner([
        "Alternate recipient wallet (fixed test seed, distinct from USER_SEED):",
        "",
        `  coin public key:       ${recipient.coinPublicKey}`,
        `  encryption public key: ${recipient.encryptionPublicKey}`,
        `  vault-token balance before the claim: ${recipientBalanceBefore}`,
      ]);
    },
    15 * MINUTE,
  );

  // Populated by the round-trip step for the balance assertion: whether THIS
  // run executed the claim (false when resuming an already-claimed request).
  let claimExecuted: boolean;

  it(
    "deposit round trip: claim names the alternate recipient and consumes the request",
    async () => {
      const { requestId, claimed } = await runDepositRoundTrip(session, env, {
        amount: DEPOSIT_AMOUNT,
        reuseRequestId: env.DEPOSIT_CLAIMANT_NOT_CALLER_DEPOSIT_REQUEST_ID as RequestIdHex | undefined,
        claimRecipient: recipientKeys(),
      });
      claimExecuted = claimed;

      // The public observable of a successful claim: the request is consumed
      // from the vault ledger — and consumption only happens after every
      // in-circuit check (MPC key, Schnorr signature, EVM success, caller
      // identity) passed.
      const context = await session.cliContext();
      const vaultContractAddress = requireConfigValue(context.config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
      const ledger = await readVaultLedger(context, vaultContractAddress);
      expect(
        ledger.signetRequestsIndex.member(requestIdBytes(requestId)),
        "claim must consume the request from the ledger",
      ).toBe(false);

      banner([
        `Deposit ${requestId} claimed with the mint directed to the alternate recipient.`,
        "",
        `  claim executed this run: ${claimed}`,
        "",
        "If a later step dies (e.g. proof-server OOM), resume with",
        `  DEPOSIT_CLAIMANT_NOT_CALLER_DEPOSIT_REQUEST_ID=${requestId}`,
      ]);
    },
    15 * MINUTE,
  );

  it(
    "assert: the alternate recipient's freshly synced wallet holds the minted shielded vault tokens",
    async () => {
      expect(claimExecuted).toBeDefined();

      // Resume tolerance: a prior run already claimed this request, so the
      // mint (and its balance delta) happened back then — nothing left to
      // observe in this run.
      if (!claimExecuted) {
        logSkip(
          "recipient balance delta assertion",
          "the request was already claimed by a prior run — the mint is not observable in this run",
        );
        return;
      }

      const recipientBalanceAfter = await readRecipientVaultTokenBalance();
      expect(
        recipientBalanceAfter - recipientBalanceBefore,
        "the alternate recipient's wallet must discover the minted coin from chain data alone",
      ).toBe(DEPOSIT_AMOUNT);

      banner([
        "The alternate recipient received the claim's shielded mint:",
        "",
        `  vault-token balance before: ${recipientBalanceBefore}`,
        `  vault-token balance after:  ${recipientBalanceAfter}`,
        `  delta:                      ${recipientBalanceAfter - recipientBalanceBefore} (deposit amount ${DEPOSIT_AMOUNT})`,
      ]);
    },
    15 * MINUTE,
  );

  it(
    "cycle funds: drain the vault's EVM ERC20 balance (fakenet-only) back to the user's derived account",
    async () => {
      const rpcUrl = requireEnv("EVM_RPC_URL");
      const vaultAddress = requireEnv("EVM_VAULT_ADDRESS");
      const erc20Address = requireEnv("ERC20_ADDRESS");

      // The claimed tokens strand on the recipient wallet, so send the
      // deposited ERC20 (plus any prior-run leftovers) back to the user's
      // derived account — the suite's EVM funds keep cycling. A zero balance
      // means a prior aborted run already drained it.
      const drained = await drainVaultErc20(env, requireEnv("EVM_USER_ADDRESS"));
      if (drained === 0n) {
        logSkip("drain", "the vault's derived account already holds no ERC20");
      }

      const { balance } = await getErc20Balance(rpcUrl, erc20Address, vaultAddress);
      expect(balance, `the vault ${vaultAddress} must hold no ERC20 after the drain`).toBe(0n);
    },
    3 * MINUTE,
  );
});
