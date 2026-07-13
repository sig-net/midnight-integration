// The false-claimer e2e flow: the vault's in-circuit caller-identity check.
// A deposit request records the DEPOSITOR's identity commitment as its MPC
// derivation path; claimDeposit recomputes the caller's commitment from the
// callerSecretKey witness and asserts it matches — so a deposit recorded for
// identity A must NOT be claimable by identity B, even with the MPC's valid
// success attestation posted.
//
// Arrange: a deposit round trip up to but NOT including the claim
// (src/flows/deposit.ts with skipClaim). Act: attempt claimDeposit through a
// SECOND session whose USER_SEED and VAULT_USER_SECRET_KEY both differ from
// the depositor's — both must be overridden together: a changed secret under
// the SAME seed would hit midnight-js's persisted private state
// (midnight-level-db, scoped per wallet account), and the stale identity
// would win. A distinct seed gets its own clean slot. The false claimer's
// wallet never pays anything — the circuit rejects during local transaction
// building, before proving or balancing — so its seed needs no funding.
// Assert: the claim rejects with the circuit's identity-assert message and
// the request STAYS on the ledger. Then identity A claims it for real (no
// stranded deposit), and the fakenet-only drain returns the deposited ERC20
// to EVM_USER_ADDRESS, so the suite's EVM funds keep cycling.
//
// Run AFTER tests/happy-day-e2e.test.ts (FILE_ORDER): initialize lives
// there. Recovery from a run that died mid-flow (proof-server OOM): rerun
// this file with FALSE_CLAIMER_DEPOSIT_REQUEST_ID set to the id the failed
// run printed.
//
// Tests drive the vault THROUGH the cli's exported command functions
// (AGENTS.md: orchestration lives in the cli, never in tests).

import {
  claimDeposit,
  ERC20_TRANSFER_GAS_LIMIT,
  ERC20_TRANSFER_MAX_FEE_PER_GAS,
  readVaultLedger,
  requireConfigValue,
} from "@midnight-erc20-vault/cli";
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

// The depositor's session (identity A): wallet facade + cli context shared by
// every test in this file (lazily built, so the offline path never touches
// the network); stopped once in afterAll.
const session = createE2eSession(env);

// The false claimer's seed AND identity secret (identity B): one fixed
// constant serving as both, deliberately different from the depositor's
// USER_SEED / VAULT_USER_SECRET_KEY (and from the claimant-not-caller flow's
// recipient seed `…42`). Both env vars are overridden together — see the
// header for why — and the seed needs no funding (the rejected claim never
// reaches proving or balancing).
const FALSE_CLAIMER_SEED = "0000000000000000000000000000000000000000000000000000000000000043";

// The false claimer's session (identity B): same lazily-built shape as the
// depositor's, over the same stack, differing ONLY in wallet seed + identity
// secret.
const falseClaimerSession = createE2eSession({
  ...env,
  USER_SEED: FALSE_CLAIMER_SEED,
  VAULT_USER_SECRET_KEY: FALSE_CLAIMER_SEED,
});

// One deposit's worth is arranged, defended against the false claimer, and
// claimed by its rightful owner — 0.1 USDC, the funding preflight's minimum.
const DEPOSIT_AMOUNT = parseUnits("0.1", 6);

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault false-claimer e2e: a deposit is only claimable by the identity that requested it", () => {
  installFlowHooks();

  afterAll(async () => {
    await session.stop();
    await falseClaimerSession.stop();
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

  // Populated by the arrange step for the claim-attempt steps.
  let depositRequestId: RequestIdHex;
  // Whether the arranged request is still on the ledger — false when a prior
  // run already claimed the resumed request, so the claim steps skip.
  let requestOnLedger: boolean;

  it(
    "arrange: deposit round trip up to (but not including) the claim — the request stays on the ledger",
    async () => {
      const { requestId, claimed } = await runDepositRoundTrip(session, env, {
        amount: DEPOSIT_AMOUNT,
        reuseRequestId: env.FALSE_CLAIMER_DEPOSIT_REQUEST_ID as RequestIdHex | undefined,
        skipClaim: true,
      });
      depositRequestId = requestId;
      expect(claimed, "skipClaim must leave the claim to this file").toBe(false);

      // Resume tolerance: a prior run may already have finished the rightful
      // claim — then the request is gone and both claim steps below skip.
      const context = await session.cliContext();
      const vaultContractAddress = requireConfigValue(context.config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
      const ledger = await readVaultLedger(context, vaultContractAddress);
      requestOnLedger = ledger.signetRequestsIndex.member(requestIdBytes(requestId));

      banner([
        `Arrange deposit ${requestId} complete — attested, UNCLAIMED, on the ledger: ${requestOnLedger}.`,
        "",
        "If a later step dies (e.g. proof-server OOM), resume with",
        `  FALSE_CLAIMER_DEPOSIT_REQUEST_ID=${requestId}`,
      ]);
    },
    15 * MINUTE,
  );

  it(
    "act: claimDeposit under a second identity rejects in-circuit and leaves the request on the ledger",
    async () => {
      expect(depositRequestId).toBeDefined();
      if (!requestOnLedger) {
        logSkip("false claim attempt", `request ${depositRequestId} already claimed by a prior run`);
        return;
      }

      // Identity B presents the SAME request id and the SAME valid MPC
      // attestation — everything a claim needs except the right secret key.
      // The circuit recomputes B's commitment from the callerSecretKey
      // witness, compares it to the request's recorded path (A's commitment
      // hex), and rejects during local transaction building.
      const falseClaimerContext = await falseClaimerSession.cliContext();
      await expect(
        claimDeposit(falseClaimerContext, { requestId: depositRequestId }),
      ).rejects.toThrow(/path hex does not match commitment/);

      // The rejection happened client-side, so nothing was consumed: the
      // request must still sit on the ledger, claimable by identity A.
      const context = await session.cliContext();
      const vaultContractAddress = requireConfigValue(context.config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
      const ledger = await readVaultLedger(context, vaultContractAddress);
      expect(
        ledger.signetRequestsIndex.member(requestIdBytes(depositRequestId)),
        "the rejected claim must not consume the request",
      ).toBe(true);

      banner([
        `False claim of deposit ${depositRequestId} rejected by the caller-identity check.`,
        "",
        "The request is still on the vault ledger, claimable by the depositor.",
      ]);
    },
    15 * MINUTE,
  );

  it(
    "cleanup: the rightful identity claims the deposit — no stranded request",
    async () => {
      expect(depositRequestId).toBeDefined();
      if (!requestOnLedger) {
        logSkip("rightful claim", `request ${depositRequestId} already claimed by a prior run`);
        return;
      }

      const context = await session.cliContext();
      await claimDeposit(context, { requestId: depositRequestId });

      const vaultContractAddress = requireConfigValue(context.config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
      const ledger = await readVaultLedger(context, vaultContractAddress);
      expect(
        ledger.signetRequestsIndex.member(requestIdBytes(depositRequestId)),
        "the rightful claim must consume the request from the ledger",
      ).toBe(false);

      banner([
        `Deposit ${depositRequestId} claimed by its rightful identity.`,
        "",
        "Same request, same attestation, the RIGHT secret key: the claim the",
        "vault rejected for identity B went through for identity A.",
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

      // The claimed value lives on as shielded tokens in the depositor's
      // wallet (this flow does not withdraw them), so send the deposited
      // ERC20 (plus any prior-run leftovers) back to the user's derived
      // account — the suite's EVM funds keep cycling. A zero balance means a
      // prior aborted run already drained it.
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
