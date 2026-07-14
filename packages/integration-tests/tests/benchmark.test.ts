// The benchmark e2e flow: one full deposit round trip and one full withdraw
// round trip, every leg driven LONG-HAND (one cli command per test) with an
// explicit stopwatch started and stopped around exactly the command under
// measurement — never inside a flow helper, so timing is visible at the call
// site and flows that don't measure never time in the background. One leg
// per test also means a narrowed vitest selection can benchmark the smallest
// unit on its own (just deposit, just claim). The measured
// legs: request/prove (deposit / withdraw), MPC signature
// latency (pollSignatureResponse), EVM confirmation (broadcastEvm),
// attestation latency (pollRespondBidirectional), and claim/settle proving
// (claim / completeWithdraw).
//
// REPORTING ONLY, by design: there is no assertion budget — a regression
// gate needs baseline data first. "Report" means (a) a human-readable
// banner table and (b) one machine-greppable `BENCHMARK_TIMINGS_JSON {...}`
// line per run, so baselines can be scraped from run logs. Deposit and
// withdraw timings stay in SEPARATE records: both round trips share leg
// names (pollSignatureResponse, broadcastEvm, pollRespondBidirectional),
// so merging them would collide. Legs a resumed/rerun pass skipped are
// absent from the report — never fabricated or resume-skewed.
//
// The flow cycles the suite's funds like the happy-day file: the deposit
// sweeps 0.1 USDC user → vault, the withdraw transfers it vault → user.
// Run AFTER tests/happy-day-e2e.test.ts (FILE_ORDER): initialize lives
// there. Recovery from a run that died mid-flow (proof-server OOM): rerun
// this file with BENCHMARK_DEPOSIT_REQUEST_ID / BENCHMARK_WITHDRAW_REQUEST_ID
// set to the ids the failed run printed.
//
// Tests drive the vault THROUGH the cli's exported command functions
// (AGENTS.md: orchestration lives in the cli, never in tests).

import {
  broadcastEvm,
  claim,
  completeWithdraw,
  ERC20_TRANSFER_GAS_LIMIT,
  ERC20_TRANSFER_MAX_FEE_PER_GAS,
  pollRespondBidirectional,
  pollSignatureResponse,
  readVaultLedger,
  deposit,
  withdraw,
  requireConfigValue,
} from "@midnight-erc20-vault/cli";
import {
  executionSucceeded,
  requestIdBytes,
  type RequestIdHex,
} from "@sig-net/midnight";
import { formatEther, parseEther, parseUnits, type Transaction } from "ethers";
import { afterAll, describe, expect, it } from "vitest";
import { requireEnv as requireEnvOf } from "../src/e2e-env.ts";
import { getErc20Balance, getEthBalance, getTransactionNonce } from "../src/evm.ts";
import { injectE2eEnv, installFlowHooks } from "../src/flow-hooks.ts";
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

// One deposit's worth of value rides the whole benchmark: deposited, claimed,
// escrowed, withdrawn — 0.1 USDC, the funding preflight's minimum.
const DEPOSIT_AMOUNT = parseUnits("0.1", 6);
const WITHDRAW_AMOUNT = DEPOSIT_AMOUNT;

/**
 * Start a stopwatch. The returned function stops it and returns the elapsed
 * wall-clock milliseconds — so every measurement in this file reads as an
 * explicit start/stop pair bracketing exactly the command being timed.
 *
 * @returns The stop function.
 */
const startTimer = (): (() => number) => {
  const startedAt = Date.now();
  return () => Date.now() - startedAt;
};

// The per-leg wall-clock records the report test prints, keyed by cli
// command name and filled by the timed legs below as they run.
const timings: {
  readonly deposit: Record<string, number>;
  readonly withdraw: Record<string, number>;
} = { deposit: {}, withdraw: {} };

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault benchmark e2e: per-leg wall-clock of a deposit + withdraw round trip", () => {
  installFlowHooks();

  afterAll(async () => {
    await session.stop();
  });

  it(
    "funding preflight: user EVM account holds the deposit minimums, vault EVM account holds the withdraw gas budget",
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

      // The withdraw tx is sent FROM the vault's derived account, which pays
      // its own gas: require the fee-cap budget of one MPC-signed ERC20
      // transfer, like the happy-day withdraw leg.
      const gasBudget = ERC20_TRANSFER_GAS_LIMIT * ERC20_TRANSFER_MAX_FEE_PER_GAS;
      const vaultEth = await getEthBalance(rpcUrl, vaultAddress);
      console.log(`${vaultAddress} ETH balance: ${vaultEth} wei (withdraw gas budget: ${gasBudget} wei)`);
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

  // ── Deposit round trip, one timed leg per test ─────────────────────────

  // Populated by the request leg (or BENCHMARK_DEPOSIT_REQUEST_ID) for the
  // subsequent deposit stages.
  let depositRequestId: RequestIdHex;

  it(
    "time deposit: record the deposit request on the vault ledger",
    async () => {
      if (env.BENCHMARK_DEPOSIT_REQUEST_ID) {
        depositRequestId = env.BENCHMARK_DEPOSIT_REQUEST_ID as RequestIdHex;
        logSkip("deposit", `BENCHMARK_DEPOSIT_REQUEST_ID present, resuming deposit '${depositRequestId}'`);
        return;
      }

      const context = await session.cliContext();
      // The sweep tx sender is the user's derived EVM account; its next
      // nonce comes from the chain — fetched OUTSIDE the timed span, which
      // brackets only the cli command under measurement.
      const evmNonce = await getTransactionNonce(requireEnv("EVM_RPC_URL"), requireEnv("EVM_USER_ADDRESS"));

      const stop = startTimer();
      depositRequestId = await deposit(context, { amount: DEPOSIT_AMOUNT, evmNonce });
      timings.deposit.deposit = stop();

      expect(depositRequestId).toMatch(/^[0-9a-f]{64}$/);

      banner([
        `Benchmark deposit request recorded on the vault ledger:`,
        "",
        `  request id: ${depositRequestId}`,
        "",
        "If a later step dies (e.g. proof-server OOM), resume with",
        `  BENCHMARK_DEPOSIT_REQUEST_ID=${depositRequestId}`,
      ]);
    },
    5 * MINUTE,
  );

  // Populated by the poll leg below for the broadcast leg.
  let signedDepositSweepTransaction: Transaction;

  it(
    "time pollSignatureResponse (deposit): the MPC signs the sweep",
    async () => {
      expect(depositRequestId).toBeDefined();
      const context = await session.cliContext();

      // Deposit sweeps are signed by the USER's derived account.
      const stop = startTimer();
      signedDepositSweepTransaction = await pollSignatureResponse(context, {
        requestId: depositRequestId,
        intervalMs: 1000,
        timeoutMs: 2 * MINUTE,
        expectedSigner: requireEnv("EVM_USER_ADDRESS"),
      });
      timings.deposit.pollSignatureResponse = stop();
    },
    5 * MINUTE,
  );

  it(
    "time broadcastEvm (deposit): the sweep mines on the EVM",
    async () => {
      expect(signedDepositSweepTransaction).toBeDefined();
      const context = await session.cliContext();

      // broadcastEvm waits for one confirmation and throws if the tx
      // reverted; on a resumed run an already-mined sweep short-circuits.
      const stop = startTimer();
      await broadcastEvm(context, { transaction: signedDepositSweepTransaction });
      timings.deposit.broadcastEvm = stop();
    },
    3 * MINUTE,
  );

  it(
    "time pollRespondBidirectional (deposit): the MPC attests the sweep as succeeded",
    async () => {
      expect(depositRequestId).toBeDefined();
      const context = await session.cliContext();

      const stop = startTimer();
      const attestation = await pollRespondBidirectional(context, {
        requestId: depositRequestId,
        intervalMs: 1000,
        timeoutMs: 2 * MINUTE,
      });
      timings.deposit.pollRespondBidirectional = stop();

      // The claim below can only mint from a success attestation.
      expect(
        executionSucceeded(attestation.serializedOutput),
        "the MPC must attest the deposit sweep as succeeded",
      ).toBe(true);
    },
    5 * MINUTE,
  );

  it(
    "time claim: verify the attestation in-circuit and consume the request",
    async () => {
      expect(depositRequestId).toBeDefined();
      const context = await session.cliContext();
      const vaultContractAddress = requireConfigValue(context.config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
      const requestKey = requestIdBytes(depositRequestId);

      // Rerun against a kept contract address: if a prior run already
      // claimed this request the entry is gone and claim would reject
      // with "Request not found" — skip cleanly instead.
      const before = await readVaultLedger(context, vaultContractAddress);
      if (!before.signetRequestsIndex.member(requestKey)) {
        logSkip("claim", `request ${depositRequestId} already claimed (not on the ledger)`);
        return;
      }

      const stop = startTimer();
      await claim(context, { requestId: depositRequestId });
      timings.deposit.claim = stop();

      const after = await readVaultLedger(context, vaultContractAddress);
      expect(
        after.signetRequestsIndex.member(requestKey),
        "claim must consume the request from the ledger",
      ).toBe(false);
    },
    15 * MINUTE,
  );

  // ── Withdraw round trip, one timed leg per test ────────────────────────

  // Populated by the request leg (or BENCHMARK_WITHDRAW_REQUEST_ID) for the
  // subsequent withdraw stages.
  let withdrawRequestId: RequestIdHex;

  it(
    "time withdraw: escrow the claimed shielded vault tokens",
    async () => {
      if (env.BENCHMARK_WITHDRAW_REQUEST_ID) {
        withdrawRequestId = env.BENCHMARK_WITHDRAW_REQUEST_ID as RequestIdHex;
        logSkip("withdraw", `BENCHMARK_WITHDRAW_REQUEST_ID present, resuming withdraw '${withdrawRequestId}'`);
        return;
      }

      const context = await session.cliContext();
      // The withdraw tx sender is the VAULT's derived EVM account; the
      // destination is the user's derived account, so the funds cycle. The
      // nonce fetch stays outside the timed span.
      const evmNonce = await getTransactionNonce(requireEnv("EVM_RPC_URL"), requireEnv("EVM_VAULT_ADDRESS"));
      const destEvmAddress = requireEnv("EVM_USER_ADDRESS");

      const stop = startTimer();
      withdrawRequestId = await withdraw(context, {
        amount: WITHDRAW_AMOUNT,
        destEvmAddress,
        evmNonce,
      });
      timings.withdraw.withdraw = stop();

      expect(withdrawRequestId).toMatch(/^[0-9a-f]{64}$/);

      banner([
        `Benchmark withdraw request recorded on the vault ledger:`,
        "",
        `  request id: ${withdrawRequestId}`,
        "",
        "If a later step dies (e.g. proof-server OOM), resume with",
        `  BENCHMARK_WITHDRAW_REQUEST_ID=${withdrawRequestId}`,
      ]);
    },
    5 * MINUTE,
  );

  // Populated by the poll leg below for the broadcast leg.
  let signedWithdrawTransaction: Transaction;

  it(
    "time pollSignatureResponse (withdraw): the MPC signs the transfer",
    async () => {
      expect(withdrawRequestId).toBeDefined();
      const context = await session.cliContext();

      // Withdraw transfers are signed by the VAULT's derived account.
      const stop = startTimer();
      signedWithdrawTransaction = await pollSignatureResponse(context, {
        requestId: withdrawRequestId,
        intervalMs: 1000,
        timeoutMs: 2 * MINUTE,
        expectedSigner: requireEnv("EVM_VAULT_ADDRESS"),
      });
      timings.withdraw.pollSignatureResponse = stop();
    },
    5 * MINUTE,
  );

  it(
    "time broadcastEvm (withdraw): the transfer mines on the EVM",
    async () => {
      expect(signedWithdrawTransaction).toBeDefined();
      const context = await session.cliContext();

      const stop = startTimer();
      await broadcastEvm(context, { transaction: signedWithdrawTransaction });
      timings.withdraw.broadcastEvm = stop();
    },
    3 * MINUTE,
  );

  it(
    "time pollRespondBidirectional (withdraw): the MPC attests the transfer as succeeded",
    async () => {
      expect(withdrawRequestId).toBeDefined();
      const context = await session.cliContext();

      const stop = startTimer();
      const attestation = await pollRespondBidirectional(context, {
        requestId: withdrawRequestId,
        intervalMs: 1000,
        timeoutMs: 3 * MINUTE,
      });
      timings.withdraw.pollRespondBidirectional = stop();

      // Happy-path benchmark: the broadcast leg saw the transfer mine, so
      // the MPC must attest success (first output byte 1).
      expect(
        executionSucceeded(attestation.serializedOutput),
        "the MPC must attest the withdraw transfer as succeeded",
      ).toBe(true);
    },
    5 * MINUTE,
  );

  it(
    "time completeWithdraw: settle the withdrawal and consume the request + refund marker",
    async () => {
      expect(withdrawRequestId).toBeDefined();
      const context = await session.cliContext();
      const vaultContractAddress = requireConfigValue(context.config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
      const requestKey = requestIdBytes(withdrawRequestId);

      // Rerun against a kept contract address: if a prior run already
      // settled this request the pending-withdrawal marker is gone and
      // completeWithdraw would reject with "Withdrawal not found" — skip
      // cleanly instead.
      const before = await readVaultLedger(context, vaultContractAddress);
      if (!before.refundCommitment.member(requestKey)) {
        logSkip(
          "completeWithdraw",
          `withdrawal ${withdrawRequestId} already settled (no pending marker on the ledger)`,
        );
        return;
      }

      const stop = startTimer();
      await completeWithdraw(context, { requestId: withdrawRequestId });
      timings.withdraw.completeWithdraw = stop();

      const after = await readVaultLedger(context, vaultContractAddress);
      expect(
        after.signetRequestsIndex.member(requestKey),
        "completeWithdraw must consume the request from the ledger",
      ).toBe(false);
    },
    15 * MINUTE,
  );

  it(
    "report: per-leg wall clock of both round trips",
    () => {
      // Legs a resumed/rerun pass skipped are simply absent — the report
      // never fabricates a number for work this run did not do.
      const section = (label: string, record: Record<string, number>): string[] => {
        const rows = Object.entries(record).map(
          ([leg, ms]) => `  ${`${label}.${leg}`.padEnd(44)}${String(ms).padStart(9)} ms`,
        );
        return rows.length > 0 ? rows : [`  ${label}: (every leg skipped — resumed or rerun pass)`];
      };

      banner([
        "Benchmark report — per-leg wall clock:",
        "",
        ...section("deposit", timings.deposit),
        ...section("withdraw", timings.withdraw),
      ]);

      // The machine-readable twin of the banner, one line per run, for
      // scraping baselines out of run logs.
      console.log(`BENCHMARK_TIMINGS_JSON ${JSON.stringify(timings)}`);
    },
    MINUTE,
  );
});
