// The failure-refund e2e flow: a withdraw whose EVM transfer FAILS must end
// with the MPC attesting failure and completeWithdraw taking the REFUND
// branch in-circuit — the escrowed shielded vault tokens re-minted to the
// caller, the request + its pending-withdrawal marker consumed.
//
// Failure-injection strategy (deliberate, deterministic): make the withdraw
// transfer MINE and REVERT by draining the vault's EVM ERC20 balance first.
// The responder (sig-net/solana-signet-program) attests an EVM outcome only
// from a mined receipt (success or revert) or a consumed nonce — it never
// times out a forever-pending tx — and a mined `status 0` receipt is exactly
// what its failure attestation (the 0xdeadbeef error sentinel) is for. The
// drain signs with the vault account's fakenet-derived key (test-support
// only, see src/fakenet-vault-account.ts) and sends the balance back to
// EVM_USER_ADDRESS, so the suite's EVM funds keep cycling. Amounts are
// computed from live balances, never assumed.
//
// The arrange stage runs a full deposit round trip first (the caller must
// hold shielded vault tokens to escrow) — that is what src/flows/deposit.ts
// exists for. Run AFTER tests/happy-day-e2e.test.ts (FILE_ORDER): initialize
// lives there. Recovery from a run that died mid-flow (proof-server OOM):
// rerun this file with FAILURE_REFUND_DEPOSIT_REQUEST_ID /
// FAILURE_REFUND_WITHDRAW_REQUEST_ID set to the ids the failed run printed.
//
// Tests drive the vault THROUGH the cli's exported command functions
// (AGENTS.md: orchestration lives in the cli, never in tests).

import {
  broadcastEvm,
  ERC20_TRANSFER_GAS_LIMIT,
  ERC20_TRANSFER_MAX_FEE_PER_GAS,
  readVaultLedger,
  requireConfigValue,
} from "@midnight-erc20-vault/cli";
import {
  executionSucceeded,
  isExecutionError,
  requestIdBytes,
  type RequestIdHex,
  type RespondBidirectional,
} from "@sig-net/midnight";
import { formatEther, parseEther, parseUnits, type Transaction } from "ethers";
import { afterAll, describe, expect, it } from "vitest";
import { requireEnv as requireEnvOf } from "../src/e2e-env.ts";
import { getErc20Balance, getEthBalance, getTransactionNonce } from "../src/evm.ts";
import { drainVaultErc20 } from "../src/fakenet-vault-account.ts";
import { injectE2eEnv, installFlowHooks } from "../src/flow-hooks.ts";
import { runDepositRoundTrip } from "../src/flows/deposit.ts";
import {
  pollSignedWithdrawLeg,
  pollWithdrawAttestationLeg,
  requestWithdrawLeg,
  settleWithdrawLeg,
} from "../src/flows/withdraw.ts";
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

// One deposit's worth of shielded vault tokens is arranged, escrowed by the
// doomed withdraw, and refunded — 0.1 USDC, the funding preflight's minimum.
const DEPOSIT_AMOUNT = parseUnits("0.1", 6);
const WITHDRAW_AMOUNT = DEPOSIT_AMOUNT;

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault deposit → withdraw-failure → refund e2e", () => {
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

      // The vault's derived account sends the doomed transfer itself (and the
      // drain before it): require the fee-cap budget of one MPC-signed ERC20
      // transfer, like the happy-day withdraw leg. Actual spend sits far
      // below the cap — a reverted transfer burns ~35k gas at live Sepolia
      // fees and the drain rides the same margin.
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

  it(
    "arrange: deposit round trip mints the shielded vault tokens the doomed withdraw will escrow",
    async () => {
      const { requestId } = await runDepositRoundTrip(session, env, {
        amount: DEPOSIT_AMOUNT,
        reuseRequestId: env.FAILURE_REFUND_DEPOSIT_REQUEST_ID as RequestIdHex | undefined,
      });

      banner([
        `Arrange deposit ${requestId} complete — the caller holds ${DEPOSIT_AMOUNT} base units of shielded vault tokens.`,
        "",
        "If a later step dies (e.g. proof-server OOM), resume with",
        `  FAILURE_REFUND_DEPOSIT_REQUEST_ID=${requestId}`,
      ]);
    },
    15 * MINUTE,
  );

  it(
    "arrange: drain the vault's EVM ERC20 balance (fakenet-only) so the withdraw transfer must revert",
    async () => {
      const rpcUrl = requireEnv("EVM_RPC_URL");
      const vaultAddress = requireEnv("EVM_VAULT_ADDRESS");
      const erc20Address = requireEnv("ERC20_ADDRESS");

      // Send the vault's FULL live balance (the arrange sweep plus any
      // prior-run leftovers) back to the user's derived account. A zero
      // balance means a prior aborted run already drained it.
      const drained = await drainVaultErc20(env, requireEnv("EVM_USER_ADDRESS"));
      if (drained === 0n) {
        logSkip("drain", "the vault's derived account already holds no ERC20");
      }

      const { balance } = await getErc20Balance(rpcUrl, erc20Address, vaultAddress);
      expect(
        balance,
        `the vault ${vaultAddress} must hold NO ERC20 so the ${WITHDRAW_AMOUNT}-unit transfer reverts`,
      ).toBe(0n);
    },
    3 * MINUTE,
  );

  // Populated by the request leg (or FAILURE_REFUND_WITHDRAW_REQUEST_ID) for
  // the subsequent stages.
  let withdrawRequestId: RequestIdHex;

  it(
    "requestWithdrawLeg: escrow shielded vault tokens for a transfer the vault cannot pay",
    async () => {
      if (env.FAILURE_REFUND_WITHDRAW_REQUEST_ID) {
        withdrawRequestId = env.FAILURE_REFUND_WITHDRAW_REQUEST_ID as RequestIdHex;
        logSkip("requestWithdrawLeg", `FAILURE_REFUND_WITHDRAW_REQUEST_ID present, resuming withdraw '${withdrawRequestId}'`);
        return;
      }

      // Nonce fetched AFTER the drain mined (the drain consumed one), so the
      // signed transfer is the vault account's next expected tx.
      const evmNonce = await getTransactionNonce(requireEnv("EVM_RPC_URL"), requireEnv("EVM_VAULT_ADDRESS"));

      withdrawRequestId = await requestWithdrawLeg(session, {
        amount: WITHDRAW_AMOUNT,
        destEvmAddress: requireEnv("EVM_USER_ADDRESS"),
        evmNonce,
      });
      expect(withdrawRequestId).toMatch(/^[0-9a-f]{64}$/);

      banner([
        `Doomed withdraw request recorded on the vault ledger:`,
        "",
        `  request id: ${withdrawRequestId}`,
        "",
        "The caller's shielded vault tokens are escrowed. If a later step dies,",
        `resume with FAILURE_REFUND_WITHDRAW_REQUEST_ID=${withdrawRequestId}`,
      ]);
    },
    5 * MINUTE,
  );

  // Populated by the poll step below for the broadcast step.
  let signedWithdrawTransaction: Transaction;

  it(
    "pollSignedWithdrawLeg: the MPC signs the doomed transfer",
    async () => {
      expect(withdrawRequestId).toBeDefined();

      signedWithdrawTransaction = await pollSignedWithdrawLeg(session, env, {
        requestId: withdrawRequestId,
      });

      banner([
        `MPC signed response for doomed withdraw ${withdrawRequestId} found from Signet Contract.`,
        "",
        `Signed tx hash: ${signedWithdrawTransaction.hash}`,
      ]);
    },
    5 * MINUTE,
  );

  it(
    "broadcast the doomed transfer: it mines and REVERTS, so broadcastEvm throws",
    async () => {
      expect(signedWithdrawTransaction).toBeDefined();
      const context = await session.cliContext();

      // broadcastEvm cannot return normally here: the transfer exceeds the
      // vault's (zero) ERC20 balance, so it mines with `status 0` and
      // broadcastEvm surfaces that as its reverted-on-chain error — also on
      // reruns, where the already-mined reverted receipt short-circuits to
      // the same throw. The mined receipt is what the responder attests from.
      await expect(
        broadcastEvm(context, { transaction: signedWithdrawTransaction }),
      ).rejects.toThrow(/reverted on-chain/);

      banner([
        `Doomed transfer ${signedWithdrawTransaction.hash} mined and reverted, as arranged.`,
        "",
        "The responder should observe the status-0 receipt and post its",
        "failure attestation (0xdeadbeef error sentinel) on its next poll.",
      ]);
    },
    3 * MINUTE,
  );

  // Populated by the poll step below for the settle step.
  let withdrawAttestation: RespondBidirectional;

  it(
    "pollWithdrawAttestationLeg: the MPC attests the transfer as FAILED",
    async () => {
      expect(withdrawRequestId).toBeDefined();

      withdrawAttestation = await pollWithdrawAttestationLeg(session, {
        requestId: withdrawRequestId,
      });

      // The observable contract of the failure leg: the attested output must
      // NOT read as success (first output byte 0x01). The responder encodes
      // a mined revert as its 0xdeadbeef error sentinel — log which failure
      // shape arrived, but pin only the success flag.
      expect(
        executionSucceeded(withdrawAttestation.serializedOutput),
        "the MPC must attest the reverted transfer as failed",
      ).toBe(false);

      banner([
        `Found failure attestation for doomed withdraw ${withdrawRequestId}:`,
        "",
        `  executionSucceeded: false`,
        `  MPC error sentinel: ${isExecutionError(withdrawAttestation.serializedOutput)}`,
      ]);
    },
    5 * MINUTE,
  );

  it(
    "settleWithdrawLeg: completeWithdraw takes the refund branch and consumes the request + refund marker",
    async () => {
      // Final leg: the request is on the vault ledger and the MPC's FAILURE
      // attestation is posted (previous steps). Settling re-verifies the
      // attestation in-circuit (pk hash, Schnorr signature) and branches on
      // the EVM result — this is the FAILURE path, so the escrowed shielded
      // value is re-minted to the pinned refund recipient instead of staying
      // burned, and the request + its pending-withdrawal marker are consumed
      // (double-settle protection). The refunded shielded balance itself is
      // not publicly observable; the marker consumption is — present before,
      // absent after — and the refund branch is the only completeWithdraw
      // path a failure attestation can take.
      expect(withdrawRequestId).toBeDefined();
      expect(withdrawAttestation).toBeDefined();

      const context = await session.cliContext();
      const vaultContractAddress = requireConfigValue(context.config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
      const requestKey = requestIdBytes(withdrawRequestId);

      // Rerun against a kept contract address: if a prior run already settled
      // this request the pending-withdrawal marker is gone and
      // completeWithdraw would reject with "Withdrawal not found" — skip
      // cleanly instead.
      const before = await readVaultLedger(context, vaultContractAddress);
      if (!before.refundRecipient.member(requestKey)) {
        logSkip(
          "settleWithdrawLeg",
          `withdrawal ${withdrawRequestId} already settled (no pending marker on the ledger)`,
        );
        return;
      }
      expect(before.signetRequestsIndex.member(requestKey)).toBe(true);

      await settleWithdrawLeg(session, { requestId: withdrawRequestId });

      const after = await readVaultLedger(context, vaultContractAddress);
      expect(
        after.signetRequestsIndex.member(requestKey),
        "completeWithdraw must consume the request from the ledger",
      ).toBe(false);
      expect(
        after.refundRecipient.member(requestKey),
        "completeWithdraw must consume the pending-withdrawal marker",
      ).toBe(false);

      banner([
        `Withdraw ${withdrawRequestId} settled with a REFUND.`,
        "",
        "The vault verified the MPC's failure attestation in-circuit,",
        "re-minted the escrowed shielded value to the pinned refund recipient,",
        "and removed the request and its refund marker from the ledger.",
      ]);
    },
    15 * MINUTE,
  );
});
