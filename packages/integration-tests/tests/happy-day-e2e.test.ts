// The happy-day e2e flow: initialization → deposit round trip → withdraw
// round trip, against contracts the globalSetup pipeline (src/setup/) has
// already compiled/deployed/derived — vitest.config.ts holds the
// orchestration contract (setup runs first, flow files run one at a time in
// a pinned order). Tests in THIS file run in source order and feed each
// other through module-scoped state, so the file is one ordered pipeline on
// purpose. Run with `yarn test:integration-tests` (all flows) or
// `yarn test:integration-tests:happy-day-e2e` (this file only) from the
// repo root (--bail 1 stops the pipeline at the first failure); without
// RUN_INTEGRATION_TESTS the whole suite skips so plain `yarn test` stays
// offline. Set STEP_THROUGH=1 to pause before each step (after the first)
// until you hit Enter in the terminal.
//
// Tests drive the vault THROUGH the cli's exported command functions
// (AGENTS.md: orchestration lives in the cli, never in tests).

import {
  broadcastEvm,
  claim,
  completeWithdraw,
  ERC20_TRANSFER_GAS_LIMIT,
  ERC20_TRANSFER_MAX_FEE_PER_GAS,
  initialize,
  pollRespondBidirectional,
  pollSignatureResponse,
  readState,
  deposit,
  withdraw,
  requireConfigValue,
} from "@midnight-erc20-vault/cli";
import {
  bytesToBigint,
  executionSucceeded,
  requestIdBytes,
  stripHexPrefix,
  type RequestIdHex,
  type RespondBidirectional,
} from "@sig-net/midnight";
import { ledger as vaultContractLedger } from "@midnight-erc20-vault/vault-contract";
import { formatEther, parseEther, parseUnits, type Transaction } from "ethers";
import { afterAll, describe, expect, it } from "vitest";
import { requireEnv as requireEnvOf } from "../src/e2e-env.ts";
import { getErc20Balance, getEthBalance, getTransactionNonce, isTransactionMined } from "../src/evm.ts";
import { injectE2eEnv, installFlowHooks } from "../src/flow-hooks.ts";
import { banner, logSkip } from "../src/output.ts";
import { createE2eSession } from "../src/session.ts";
import { pollSignetNotification } from "../src/signet-notifications.ts";

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

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault happy-day e2e", () => {
  installFlowHooks();

  afterAll(async () => {
    await session.stop();
  });

  it(
    "initialize [erc-vault contract method call]: seal vault EVM address and read back state",
    async () => {
      const vaultEvmAddress = requireEnv("EVM_VAULT_ADDRESS");
      const context = await session.cliContext();
      const vaultContractAddress = requireConfigValue(context.config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");

      const readLedger = async () => {
        const contractState = await context.providers.publicDataProvider.queryContractState(vaultContractAddress);
        if (!contractState) {
          throw new Error(`no contract state found at ${vaultContractAddress}`);
        }
        return vaultContractLedger(contractState.data);
      };

      if ((await readLedger()).initialized) {
        logSkip("initialize", "vault is already initialized (rerun against a kept contract address)");
      } else {
        await initialize(context, { vaultEvmAddress });
      }

      await readState(context);

      const state = await readLedger();
      expect(state.initialized).toBe(1n);
      expect(`0x${Buffer.from(state.vaultEvmAddress).toString("hex")}`.toLowerCase()).toBe(
        vaultEvmAddress.toLowerCase(),
      );
      // The pinned chain config: numeric id + zero-padded CAIP-2 string.
      expect(state.evmChainId).toBe(BigInt(requireEnv("EVM_CHAIN_ID")));
      expect(new TextDecoder().decode(state.caip2Id).replace(/\0+$/u, "")).toBe(
        `eip155:${requireEnv("EVM_CHAIN_ID")}`,
      );
    },
    15 * MINUTE,
  );

  it(
    "deposit funding preflight: check user EVM account for minimum ETH and USDC balances.",
    async () => {
      const rpcUrl = requireEnv("EVM_RPC_URL");
      const userAddress = requireEnv("EVM_USER_ADDRESS");
      const erc20Address = requireEnv("ERC20_ADDRESS");

      const ethBalance = await getEthBalance(rpcUrl, userAddress);
      console.log(`${userAddress} ETH balance: ${ethBalance} wei`);
      expect(ethBalance, `fund ${userAddress} with >= 0.009 ETH on EVM`).toBeGreaterThanOrEqual(
        parseEther("0.009"),
      );

      const { balance, decimals } = await getErc20Balance(rpcUrl, erc20Address, userAddress);
      console.log(`${userAddress} balance on ${erc20Address}: ${balance} (decimals ${decimals})`);
      expect(balance, `fund ${userAddress} with >= 0.1 of ERC20 ${erc20Address} on EVM`).toBeGreaterThanOrEqual(
        parseUnits("0.1", decimals),
      );
    },
    MINUTE,
  );

  // prepare request Id for use in subsequent tests
  // It is populated by the deposit test.
  let depositTransactionSignatureRequestId: RequestIdHex;

  it(
    "deposit [erc-vault contract method call]: request a deposit through the cli and read it back MPC-style",
    async () => {
      // check if a request Id was given in then environment (for skipping steps during local development)
      if (env.DEPOSIT_REQUEST_ID) {
        depositTransactionSignatureRequestId = env.DEPOSIT_REQUEST_ID as RequestIdHex;
        logSkip("deposit", `DEPOSIT_REQUEST_ID present in environment, skipping deposit call '${depositTransactionSignatureRequestId}'`);
        return;
      }

      const context = await session.cliContext();

      // The sweep tx sender is the user's derived EVM account; its next nonce
      // comes from the chain, exactly as a wallet would fetch it.
      const evmNonce = await getTransactionNonce(requireEnv("EVM_RPC_URL"), requireEnv("EVM_USER_ADDRESS"));
      const amount = parseUnits("0.1", 6); // 0.1 USDC — the funding preflight's minimum

      depositTransactionSignatureRequestId = await deposit(context, { amount, evmNonce });
      await readState(context);

      expect(depositTransactionSignatureRequestId).toMatch(/^[0-9a-f]{64}$/);

      // MPC-convention verification: fetch the request record the way the
      // response server does — through a SignetRequestResponseReader over RAW
      // contract state. getSignatureRequest throws when the id is absent, so a
      // returned record is itself proof the request landed on the vault ledger.
      const record = await session.responseReader().getSignatureRequest(
        depositTransactionSignatureRequestId,
      );
      expect(record.txParams.nonce).toBe(evmNonce);
      expect(record.txParams.calldata.is_some).toBe(true);
      expect(bytesToBigint(record.txParams.calldata.value.words[1])).toBe(
        amount,
      );

      banner([
        `Deposit request recorded on the vault ledger:`,
        "",
        `  request id: ${depositTransactionSignatureRequestId}`,
        "",
        "The response server (yarn response, MIDNIGHT_SIGNET_CONTRACT_ADDRESS set)",
        "polls the signet contract's notification registry and should pick it up",
        "on its next poll — resolving it from THIS vault's ledger — and sign the EVM tx.",
      ]);
    },
    5 * MINUTE,
  );

  it(
    "golden notification: the vault's deposit registered a decodable notification in the signet registry",
    async () => {
      // Pins the SignBidirectionalNotification payload layout against a LIVE
      // indexer, read exactly the way the MPC reads it — raw signet state by
      // field position through the hand-composed descriptors. The vault's
      // deposit cross-contract-called notifyBidirectionalSignatureRequest to
      // register this.
      expect(depositTransactionSignatureRequestId).toBeDefined();
      const vaultAddress = requireEnv("MIDNIGHT_VAULT_CONTRACT_ADDRESS");

      const decoded = await pollSignetNotification({
        env,
        requestId: depositTransactionSignatureRequestId,
        description: `for request ${depositTransactionSignatureRequestId}`,
      });

      // callerAddress points at the vault (the contract whose authenticated
      // ledger holds the request); requestId matches; the index is at field 0.
      expect(decoded.version).toBe(1);
      expect(decoded.callerAddress).toBe(stripHexPrefix(vaultAddress).toLowerCase());
      expect(decoded.requestId).toBe(depositTransactionSignatureRequestId);
      expect(decoded.requestsIndexField).toBe(0);

      banner([
        "Golden SignBidirectionalNotification decoded from the live indexer:",
        "",
        `  version:            ${decoded.version}`,
        `  callerAddress:      ${decoded.callerAddress}`,
        `  requestId:          ${decoded.requestId}`,
        `  requestsIndexField: ${decoded.requestsIndexField}`,
      ]);
    },
    2 * MINUTE,
  );

  // prepare deposit sweep transaction sinature for use in subsequent tests
  let signedDepositSweepTransaction: Transaction;

  it(
    "pollSignatureResponse: poll signet contract for sweep transaction signature response",
    async () => {
      // confirm request Id set in previous test after successful deplost request
      expect(depositTransactionSignatureRequestId).toBeDefined();

      const context = await session.cliContext();
      // Deposit sweeps are signed by the USER's derived account.
      signedDepositSweepTransaction = await pollSignatureResponse(context, {
        requestId: depositTransactionSignatureRequestId,
        intervalMs: 1000,
        timeoutMs: 1 * MINUTE,
        expectedSigner: requireEnv("EVM_USER_ADDRESS"),
      });

      banner([
        `MPC signed Response for request ${depositTransactionSignatureRequestId} found from Signet Contract.`,
        "",
        `Signature: ${signedDepositSweepTransaction}`,
      ]);
    },
    5 * MINUTE,
  );

  it(
    "broadcast deposit sweep evm txn: broadcase to evm",
    async () => {
      // confirm depositSweepTxn set in previous test after successful deploy request
      expect(signedDepositSweepTransaction).toBeDefined();

      const context = await session.cliContext();
      const result = await broadcastEvm(context, { transaction: signedDepositSweepTransaction });

      banner([
        `Deposit sweep transaction broadcast to EVM.`,
        "",
        `Deposit Sweep Transaction Hex: ${result}`,
      ]);
    },
    1 * MINUTE,
  );

  // prepare deposit transaction respond-bidirectional attestation for use in subsequent transactions
  let depositSweepTransactionRespondBidirectional: RespondBidirectional;

  it(
    "pollRespondBidirectional: poll signet contract for sweep transaction signature response",
    async () => {
      // confirm request Id set in previous test after successful deplost request
      expect(depositTransactionSignatureRequestId).toBeDefined();

      const context = await session.cliContext();
      depositSweepTransactionRespondBidirectional = await pollRespondBidirectional(context, {
        requestId: depositTransactionSignatureRequestId,
        intervalMs: 1000,
        timeoutMs: 1 * MINUTE,
      });

      banner([
        `Found Deposit transaction respond-bidirectional attestation from signet contract: '${executionSucceeded(depositSweepTransactionRespondBidirectional.serializedOutput)}' (${depositSweepTransactionRespondBidirectional.response})`,
        "",
        `Signature: ${signedDepositSweepTransaction}`,
      ]);
    },
    5 * MINUTE,
  );

  it(
    "claim [erc-vault contract method call]: verify the MPC attestation in-circuit and consume the request",
    async () => {
      // Final leg of the deposit round trip: the request is on the vault ledger
      // and the MPC's respond-bidirectional attestation is posted (previous
      // steps). Claiming re-verifies the attestation IN-CIRCUIT (pk hash,
      // Schnorr signature, EVM success flag) and the caller identity, then mints
      // shielded vault tokens and CONSUMES the request (double-claim
      // protection). The mint is shielded so it isn't publicly observable; the
      // request's removal from RAW ledger state is — present before, absent
      // after — and it only happens if every in-circuit check passed.
      expect(depositTransactionSignatureRequestId).toBeDefined();
      expect(depositSweepTransactionRespondBidirectional).toBeDefined();

      const context = await session.cliContext();
      const vaultContractAddress = requireConfigValue(context.config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
      const requestKey = requestIdBytes(depositTransactionSignatureRequestId);

      const isRequestOnLedger = async () => {
        const contractState = await context.providers.publicDataProvider.queryContractState(vaultContractAddress);
        if (!contractState) {
          throw new Error(`no contract state found at ${vaultContractAddress}`);
        }
        return vaultContractLedger(contractState.data).signetRequestsIndex.member(requestKey);
      };

      // Rerun against a kept contract address: if a prior run already claimed
      // this request the entry is gone and claim would reject with
      // "Request not found" — skip cleanly instead.
      if (!(await isRequestOnLedger())) {
        logSkip("claim", `request ${depositTransactionSignatureRequestId} already claimed (not on the ledger)`);
        return;
      }

      await claim(context, { requestId: depositTransactionSignatureRequestId });
      await readState(context);

      expect(
        await isRequestOnLedger(),
        "claim must consume the request from the ledger",
      ).toBe(false);

      banner([
        `Deposit ${depositTransactionSignatureRequestId} claimed.`,
        "",
        "The vault verified the MPC attestation in-circuit, minted shielded",
        "vault tokens to the caller, and removed the request from its ledger.",
      ]);
    },
    15 * MINUTE,
  );

  // ── Withdraw leg: drive the deposited 0.1 USDC back OUT of the vault to the
  // user's derived EVM account, spending the shielded tokens the claim minted.
  const WITHDRAW_AMOUNT = parseUnits("0.1", 6);

  it(
    "withdraw funding preflight: check vault EVM account for minimum ETH (gas) and ERC20 balances.",
    async () => {
      const rpcUrl = requireEnv("EVM_RPC_URL");
      const vaultAddress = requireEnv("EVM_VAULT_ADDRESS");
      const erc20Address = requireEnv("ERC20_ADDRESS");

      // The withdraw tx is sent FROM the vault's derived account, which pays
      // its own gas: require the full fee-cap budget of one MPC-signed ERC20
      // transfer (gas limit x max fee per gas).
      const gasBudget = ERC20_TRANSFER_GAS_LIMIT * ERC20_TRANSFER_MAX_FEE_PER_GAS;
      const ethBalance = await getEthBalance(rpcUrl, vaultAddress);
      console.log(`${vaultAddress} ETH balance: ${ethBalance} wei (withdraw gas budget: ${gasBudget} wei)`);
      expect(
        ethBalance,
        `fund the vault's derived account ${vaultAddress} with >= ${formatEther(gasBudget)} ETH on EVM`,
      ).toBeGreaterThanOrEqual(gasBudget);

      const { balance, decimals } = await getErc20Balance(rpcUrl, erc20Address, vaultAddress);
      console.log(`${vaultAddress} balance on ${erc20Address}: ${balance} (decimals ${decimals})`);
      expect(
        balance,
        `the vault ${vaultAddress} must hold >= 0.1 of ERC20 ${erc20Address} — did the deposit sweep land?`,
      ).toBeGreaterThanOrEqual(WITHDRAW_AMOUNT);
    },
    MINUTE,
  );

  // Populated by the withdraw test (or WITHDRAW_REQUEST_ID) for the
  // subsequent withdraw stages.
  let withdrawTransactionSignatureRequestId: RequestIdHex;

  it(
    "withdraw [erc-vault contract method call]: escrow shielded vault tokens and read the request back MPC-style",
    async () => {
      // check if a request Id was given in the environment (for skipping steps during local development)
      if (env.WITHDRAW_REQUEST_ID) {
        withdrawTransactionSignatureRequestId = env.WITHDRAW_REQUEST_ID as RequestIdHex;
        logSkip("withdraw", `WITHDRAW_REQUEST_ID present in environment, skipping withdraw call '${withdrawTransactionSignatureRequestId}'`);
        return;
      }

      const context = await session.cliContext();

      // The withdraw tx sender is the VAULT's derived EVM account; its next
      // nonce comes from the chain, exactly as a wallet would fetch it. The
      // destination is the user's derived account, so the suite's funds cycle.
      const evmNonce = await getTransactionNonce(requireEnv("EVM_RPC_URL"), requireEnv("EVM_VAULT_ADDRESS"));
      const destEvmAddress = requireEnv("EVM_USER_ADDRESS");

      withdrawTransactionSignatureRequestId = await withdraw(context, {
        amount: WITHDRAW_AMOUNT,
        destEvmAddress,
        evmNonce,
      });
      await readState(context);

      expect(withdrawTransactionSignatureRequestId).toMatch(/^[0-9a-f]{64}$/);

      // MPC-convention verification: the request resolves from RAW vault
      // state through the same reader the response server uses — recorded
      // under the VAULT's derivation path, with contract-built calldata.
      const record = await session.responseReader().getSignatureRequest(
        withdrawTransactionSignatureRequestId,
      );
      expect(record.txParams.nonce).toBe(evmNonce);
      expect(record.txParams.calldata.is_some).toBe(true);
      expect(bytesToBigint(record.txParams.calldata.value.words[1])).toBe(
        WITHDRAW_AMOUNT,
      );
      expect(new TextDecoder().decode(record.path).replace(/\0+$/u, "")).toBe("vault");

      banner([
        `Withdraw request recorded on the vault ledger:`,
        "",
        `  request id: ${withdrawTransactionSignatureRequestId}`,
        "",
        "The caller's shielded vault tokens are escrowed. The response server",
        "should pick the request up on its next poll and sign the EVM transfer",
        "FROM the vault's derived account (path \"vault\").",
      ]);
    },
    5 * MINUTE,
  );

  it(
    "watch withdraw signature request: the withdraw registered a notification in the signet registry",
    async () => {
      // The same registry poll the MPC runs for discovery: withdraw
      // cross-contract-called notifyBidirectionalSignatureRequest to register
      // this.
      expect(withdrawTransactionSignatureRequestId).toBeDefined();
      const vaultAddress = requireEnv("MIDNIGHT_VAULT_CONTRACT_ADDRESS");

      const decoded = await pollSignetNotification({
        env,
        requestId: withdrawTransactionSignatureRequestId,
        description: `for withdraw request ${withdrawTransactionSignatureRequestId}`,
      });

      expect(decoded.callerAddress).toBe(stripHexPrefix(vaultAddress).toLowerCase());
      expect(decoded.requestsIndexField).toBe(0);

      banner([
        "Notification observed for the withdraw request:",
        "",
        `  callerAddress: ${decoded.callerAddress}`,
        `  requestId:     ${decoded.requestId}`,
      ]);
    },
    2 * MINUTE,
  );

  // Populated by the poll step below for the broadcast step.
  let signedWithdrawTransaction: Transaction;

  it(
    "pollSignatureResponse: poll signet contract for withdraw transaction signature response",
    async () => {
      expect(withdrawTransactionSignatureRequestId).toBeDefined();

      const context = await session.cliContext();
      // Withdraw transactions are signed by the VAULT's derived account, not
      // the user's — verify the MPC's signature against it.
      signedWithdrawTransaction = await pollSignatureResponse(context, {
        requestId: withdrawTransactionSignatureRequestId,
        intervalMs: 1000,
        timeoutMs: 1 * MINUTE,
        expectedSigner: requireEnv("EVM_VAULT_ADDRESS"),
      });

      banner([
        `MPC signed response for withdraw request ${withdrawTransactionSignatureRequestId} found from Signet Contract.`,
        "",
        `Signature: ${signedWithdrawTransaction}`,
      ]);
    },
    5 * MINUTE,
  );

  it(
    "broadcast withdraw evm txn: the ERC20 leaves the vault on the EVM side",
    async () => {
      expect(signedWithdrawTransaction).toBeDefined();
      const rpcUrl = requireEnv("EVM_RPC_URL");
      const erc20Address = requireEnv("ERC20_ADDRESS");
      const destination = requireEnv("EVM_USER_ADDRESS");
      const context = await session.cliContext();

      // Rerun tolerance: if this signed tx already mined on a previous run,
      // re-broadcasting is an idempotent no-op and the balance delta below
      // would read 0 — skip the delta assertion in that case.
      const alreadyMined =
        signedWithdrawTransaction.hash !== null &&
        (await isTransactionMined(rpcUrl, signedWithdrawTransaction.hash));
      const before = await getErc20Balance(rpcUrl, erc20Address, destination);

      // broadcastEvm waits for one confirmation and throws if the tx reverted.
      const txHash = await broadcastEvm(context, { transaction: signedWithdrawTransaction });

      if (alreadyMined) {
        logSkip("withdraw balance delta assertion", `tx ${txHash} had already mined on a previous run`);
      } else {
        const after = await getErc20Balance(rpcUrl, erc20Address, destination);
        expect(
          after.balance - before.balance,
          `the destination ${destination} must receive the withdrawn ERC20`,
        ).toBe(WITHDRAW_AMOUNT);
      }

      banner([
        `Withdraw transaction mined on EVM: ${txHash}`,
        "",
        `The vault's derived account transferred ${WITHDRAW_AMOUNT} base units of`,
        `${erc20Address} to ${destination}.`,
      ]);
    },
    2 * MINUTE,
  );

  // Populated by the poll step below for the settle step.
  let withdrawRespondBidirectional: RespondBidirectional;

  it(
    "pollRespondBidirectional: poll signet contract for withdraw transaction attestation",
    async () => {
      expect(withdrawTransactionSignatureRequestId).toBeDefined();

      const context = await session.cliContext();
      withdrawRespondBidirectional = await pollRespondBidirectional(context, {
        requestId: withdrawTransactionSignatureRequestId,
        intervalMs: 1000,
        timeoutMs: 1 * MINUTE,
      });

      // Happy-day flow: the broadcast step saw the transfer mine, so the MPC
      // must attest success (first output byte 1), not its error sentinel.
      expect(
        executionSucceeded(withdrawRespondBidirectional.serializedOutput),
        "the MPC must attest the withdraw transfer as succeeded",
      ).toBe(true);

      banner([
        `Found withdraw respond-bidirectional attestation from signet contract: ` +
          `'${executionSucceeded(withdrawRespondBidirectional.serializedOutput)}' ` +
          `(${withdrawRespondBidirectional.response})`,
      ]);
    },
    5 * MINUTE,
  );

  it(
    "completeWithdraw [erc-vault contract method call]: verify the MPC attestation in-circuit and settle the withdrawal",
    async () => {
      // Final leg of the withdraw round trip: the request is on the vault
      // ledger and the MPC's attestation is posted (previous steps). Settling
      // re-verifies the attestation IN-CIRCUIT (pk hash, Schnorr signature)
      // and branches on the EVM result — this is the HAPPY path, so the
      // withdrawal finalizes with NO refund (the surrendered value stays
      // burned) and the request + its pending-withdrawal marker are CONSUMED
      // (double-settle protection). Both removals are publicly observable on
      // RAW ledger state — present before, absent after — and only happen if
      // every in-circuit check passed.
      expect(withdrawTransactionSignatureRequestId).toBeDefined();
      expect(withdrawRespondBidirectional).toBeDefined();

      const context = await session.cliContext();
      const vaultContractAddress = requireConfigValue(context.config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
      const requestKey = requestIdBytes(withdrawTransactionSignatureRequestId);

      const readVaultLedger = async () => {
        const contractState = await context.providers.publicDataProvider.queryContractState(vaultContractAddress);
        if (!contractState) {
          throw new Error(`no contract state found at ${vaultContractAddress}`);
        }
        return vaultContractLedger(contractState.data);
      };

      // Rerun against a kept contract address: if a prior run already settled
      // this request the pending-withdrawal marker is gone and completeWithdraw
      // would reject with "Withdrawal not found" — skip cleanly instead.
      const before = await readVaultLedger();
      if (!before.refundCommitment.member(requestKey)) {
        logSkip(
          "completeWithdraw",
          `withdrawal ${withdrawTransactionSignatureRequestId} already settled (no pending marker on the ledger)`,
        );
        return;
      }
      expect(before.signetRequestsIndex.member(requestKey)).toBe(true);

      await completeWithdraw(context, { requestId: withdrawTransactionSignatureRequestId });
      await readState(context);

      const after = await readVaultLedger();
      expect(
        after.signetRequestsIndex.member(requestKey),
        "completeWithdraw must consume the request from the ledger",
      ).toBe(false);
      expect(
        after.refundCommitment.member(requestKey),
        "completeWithdraw must consume the pending-withdrawal marker",
      ).toBe(false);

      banner([
        `Withdraw ${withdrawTransactionSignatureRequestId} settled (success — no refund).`,
        "",
        "The vault verified the MPC attestation in-circuit, finalized the",
        "withdrawal, and removed the request and its refund marker from the",
        "ledger.",
      ]);
    },
    15 * MINUTE,
  );
});
