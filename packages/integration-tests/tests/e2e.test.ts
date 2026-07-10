// The ordered e2e pipeline: environment check → setup (compile, deploy,
// derive keys/addresses, MPC hand-off printout) → initialization → deposit →
// withdraw.
// One file ON PURPOSE: vitest runs same-file tests sequentially, and the
// setup steps feed each other through the env accumulator below. Run with
// `npm run test:integration-tests` from the repo root (--bail stops the pipeline
// at the first failure); without RUN_INTEGRATION_TESTS the whole suite
// skips so plain `npm run test` stays offline. Set STEP_THROUGH=1 to pause
// before each step (after the first) until you hit Enter in the terminal.
//
// Tests drive the vault THROUGH the cli's exported command functions
// (AGENTS.md: orchestration lives in the cli, never in tests).

import {
  broadcastEvm,
  claimDeposit,
  completeWithdraw,
  type CliContext,
  createCliContext,
  ERC20_TRANSFER_GAS_LIMIT,
  ERC20_TRANSFER_MAX_FEE_PER_GAS,
  getCliConfig,
  getUserIdentity,
  initialize,
  pollRespondBidirectional,
  pollSignatureResponse,
  readState,
  requestDeposit,
  requestWithdraw,
  requireConfigValue,
} from "@midnight-erc20-vault/cli";
import { deriveAccountKeys, getDeployConfig, getMidnightNodeConfig, initialiseWalletFacade, type WalletFacade } from "@midnight-erc20-vault/lib";
import {
  bytesToBigint,
  deriveEvmAddress,
  deriveMpcKeys,
  formatJubjubPublicKey,
  generateMpcRootKey,
  executionSucceeded,
  SignetRequestResponseReader,
  RESPOND_BIDIRECTIONAL_EVENT_TAG,
  SIGN_BIDIRECTIONAL_EVENT_TAG,
  SIGNATURE_RESPONDED_EVENT_TAG,
  decodeRespondBidirectionalEvent,
  decodeSignBidirectionalEvent,
  decodeSignatureRespondedEvent,
  eventNameTag,
  hexToBytes,
  requestIdBytes,
  stripHexPrefix,
  type RespondBidirectional,
  type RequestIdHex,
} from "@midnight-erc20-vault/signet-midnight";
import { deployVault, ledger as vaultContractLedger } from "@midnight-erc20-vault/vault-contract";
import { deploySignetContract } from "@midnight-erc20-vault/signet-contract";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { formatEther, parseEther, parseUnits, type Transaction } from "ethers";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadRepoDotEnv } from "../src/env-file.ts";
import { assertCommandAvailable, assertHttpReachable } from "../src/preflight.ts";
import { getErc20Balance, getEthBalance, getTransactionNonce, isTransactionMined, SEPOLIA_USDC_ADDRESS } from "../src/evm.ts";
import { runRootScript } from "../src/subprocess.ts";
import { waitForGo } from "../src/waitForGo.ts";

const MINUTE = 60_000;

/**
 * Environment accumulator: seeded from the repo-root `.env` file overlaid
 * with the real environment (which wins), then populated by the setup steps.
 * Each pipeline value lives under its canonical env-var name — presence
 * doubles as the step's skip signal, and the final printout is exactly this
 * map's pipeline keys. `process.env` itself is never mutated; the
 * accumulator is passed explicitly to config readers and subprocesses.
 */
const env: NodeJS.ProcessEnv = { ...loadRepoDotEnv(), ...process.env };

// The cli needs the EVM-side config; default what the environment hasn't
// pinned (EVM + canonical USDC, matching the funding preflight). Set
// before any test builds a CliConfig so the shared context sees them.
env.ERC20_ADDRESS ??= SEPOLIA_USDC_ADDRESS;
env.EVM_CHAIN_ID ??= "11155111";

/**
 * The env keys the setup steps populate. Used only to build the "Minimal .env
 * block" printout — order here is purely cosmetic (execution order is fixed by
 * the sequence of `it()` blocks, not this array). Kept in derivation order so
 * the printed block reads like the flow that produced it.
 */
const PIPELINE_KEYS = [
  "MPC_ROOT_KEY",
  "MPC_JUBJUB_PK",
  "MPC_SECP256K1_PUBKEY",
  "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
  "MIDNIGHT_SIGNET_CONTRACT_ADDRESS",
  "EVM_VAULT_ADDRESS",
  "EVM_USER_ADDRESS",
] as const;

/** Assert a prior step populated `name`, failing with a pointed message. */
function requireEnv(name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is not set — did the step that derives it run (or is it missing from your .env)?`);
  }
  return value;
}

/** Loud, uniform skip line so skipped steps are obvious in the output. */
function logSkip(step: string, reason: string): void {
  console.log(`SKIPPED: ${step} — ${reason}`);
}

/** Print a value the operator must save, too loud to miss. */
function banner(lines: string[]): void {
  const border = "=".repeat(72);
  console.log(`\n${border}\n${lines.join("\n")}\n${border}\n`);
}

/**
 * Print a bold header at the start of each test. We run with
 * `--disable-console-intercept` (so subprocess output streams live), which
 * means vitest does NOT prefix logs with their test name — this header is what
 * segments the streaming output and shows which step is currently running.
 * A heavy rule (`━`) distinguishes step boundaries from value banners (`=`).
 */
function testHeader(index: number, total: number, name: string): void {
  const border = "━".repeat(72);
  console.log(`\n${border}\n▶  TEST ${index}/${total}  ${name}\n${border}`);
}

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault e2e", () => {
  // - Print a header before each test.
  // - Check for step through mode to pause between each step.
  beforeEach(async (ctx) => {
    const siblings = ctx.task.suite?.tasks ?? [];
    const index = siblings.indexOf(ctx.task);
    if (process.env.STEP_THROUGH && index > 0) {
      await waitForGo(index + 1, siblings.length, ctx.task.name);
    }
    testHeader(index + 1, siblings.length, ctx.task.name);
  }, 60 * MINUTE);

  it(
    "environment: midnight stack reachable, compact on PATH, EVM_RPC_URL set",
    async () => {
      const nodeConfig = getMidnightNodeConfig(env);
      await assertHttpReachable("midnight node", new URL("/health", nodeConfig.nodeUrl).href);
      await assertHttpReachable("indexer", nodeConfig.indexerUrl);
      await assertHttpReachable("proof server", nodeConfig.proofServerUrl);
      await assertCommandAvailable("compact", ["--version"]);
      requireEnv("EVM_RPC_URL");

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
    },
    MINUTE,
  );

  it("setup: check/derive MPC root key", () => {
    if (env.MPC_ROOT_KEY) {
      logSkip("check/derive MPC root key", `MPC_ROOT_KEY is set as ${env.MPC_ROOT_KEY}`);
      return;
    }
    env.MPC_ROOT_KEY = generateMpcRootKey();
    console.log(`generated a fresh MPC_ROOT_KEY=${env.MPC_ROOT_KEY}`);
    console.log(` ➜ seeds MPC key generation`);
    console.log(` ➜ 💡 Set as MPC_ROOT_KEY in the environment to skip this step on the next run`);
    console.log("(printed again in the MPC server configuration step)");
  });

  // Derive MPC keys for setting or checking public keys. Must be called
  // INSIDE the tests below — the describe body runs at collection time,
  // before the root-key step above has a chance to generate MPC_ROOT_KEY.
  const mpcKeys = () => deriveMpcKeys(requireEnv("MPC_ROOT_KEY"));

  it("setup: check/derive MPC_JUBJUB_PK public key", () => {
    const expectedMPCJubjubPK = formatJubjubPublicKey(mpcKeys().jubjubPoint);
    if (env.MPC_JUBJUB_PK) {
      console.log(`Found MPC_JUBJUB_PK in the environment as ${env.MPC_JUBJUB_PK}`);
      expect(env.MPC_JUBJUB_PK, "MPC_JUBJUB_PK should be derived from MPC_ROOT_KEY").toBe(expectedMPCJubjubPK);
      logSkip("check/derive MPC_JUBJUB_PK public key", `MPC_JUBJUB_PK is set correctly`);
      return;
    }
    env.MPC_JUBJUB_PK = expectedMPCJubjubPK;
    console.log(`generated a fresh MPC_JUBJUB_PK=${env.MPC_JUBJUB_PK}`);
    console.log(` ➜ used by contracts to validate signatures`);
    console.log(` ➜ 💡 Set as MPC_JUBJUB_PK in the environment to skip this step on the next run`);
  });

  it("setup: check/derive MPC_SECP256K1_PUBKEY public key", () => {
    const expectedSECP256k1CompressedPubkey = mpcKeys().secp256k1CompressedPubkey;
    if (env.MPC_SECP256K1_PUBKEY) {
      console.log(`Found MPC_SECP256K1_PUBKEY in the environment as ${env.MPC_SECP256K1_PUBKEY}`);
      expect(env.MPC_SECP256K1_PUBKEY, "MPC_SECP256K1_PUBKEY should be derived from MPC_ROOT_KEY").toBe(expectedSECP256k1CompressedPubkey);
      logSkip("check/derive MPC_SECP256K1_PUBKEY public key", `MPC_SECP256K1_PUBKEY is set correctly`);
      return;
    }
    env.MPC_SECP256K1_PUBKEY = expectedSECP256k1CompressedPubkey;
    console.log(`generated a fresh MPC_SECP256K1_PUBKEY=${env.MPC_SECP256K1_PUBKEY}`);
    console.log(` ➜ used by contracts to validate signatures`);
    console.log(` ➜ 💡 Set as MPC_SECP256K1_PUBKEY in the environment to skip this step on the next run`);
  });

  // The signet contract is deployed FIRST: the vault seals its address as the
  // cross-contract emitter, and the vault compile symlinks the signet's managed
  // output (its ZK keys) for the cross-contract proof.
  it(
    "setup: compile signet-contract contract with proving keys",
    async () => {
      if (env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS) {
        logSkip("compile:signet-contract:zk", `MIDNIGHT_SIGNET_CONTRACT_ADDRESS is set (${env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS})`);
        return;
      }
      await runRootScript("compile:signet-contract:zk", env, 14 * MINUTE);
    },
    15 * MINUTE,
  );

  it(
    "setup: deploy signet-contract",
    async () => {
      if (env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS) {
        logSkip("deploy:signet-contract", `MIDNIGHT_SIGNET_CONTRACT_ADDRESS is set (${env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS})`);
        return;
      }
      const { contractAddress } = await deploySignetContract(env);
      env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS = contractAddress;
      console.log(`deployed a fresh MIDNIGHT_SIGNET_CONTRACT_ADDRESS=${contractAddress}`);
      console.log(` ➜ the central signet contract on Midnight — records signature requests and authenticated MPC responses`);
      console.log(` ➜ 💡 Set as MIDNIGHT_SIGNET_CONTRACT_ADDRESS in the environment to skip compile + deploy on the next run`);
    },
    10 * MINUTE,
  );

  it(
    "setup: compile vault contract with proving keys",
    async () => {
      if (env.MIDNIGHT_VAULT_CONTRACT_ADDRESS) {
        logSkip("compile:vault-contract:zk", `MIDNIGHT_VAULT_CONTRACT_ADDRESS is set (${env.MIDNIGHT_VAULT_CONTRACT_ADDRESS})`);
        return;
      }
      await runRootScript("compile:vault-contract:zk", env, 14 * MINUTE);
    },
    15 * MINUTE,
  );

  it(
    "setup: deploy vault contract",
    async () => {
      if (env.MIDNIGHT_VAULT_CONTRACT_ADDRESS) {
        logSkip("deploy:vault-contract", `MIDNIGHT_VAULT_CONTRACT_ADDRESS is set (${env.MIDNIGHT_VAULT_CONTRACT_ADDRESS})`);
        return;
      }
      const { contractAddress } = await deployVault(env);
      env.MIDNIGHT_VAULT_CONTRACT_ADDRESS = contractAddress;
      console.log(`deployed a fresh MIDNIGHT_VAULT_CONTRACT_ADDRESS=${contractAddress}`);
      console.log(` ➜ the vault contract on Midnight — holds deposits and authorizes withdrawals`);
      console.log(` ➜ 💡 Set as MIDNIGHT_VAULT_CONTRACT_ADDRESS in the environment to skip compile + deploy on the next run`);
    },
    10 * MINUTE,
  );

  it("setup: check/derive vault EVM address", () => {
    const expectedAddress = deriveEvmAddress(
      requireEnv("MPC_SECP256K1_PUBKEY"),
      requireEnv("MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
      "vault",
    );
    if (env.EVM_VAULT_ADDRESS) {
      console.log(`Found EVM_VAULT_ADDRESS in the environment as ${env.EVM_VAULT_ADDRESS}`);
      expect(env.EVM_VAULT_ADDRESS, "EVM_VAULT_ADDRESS should be derived from MPC_SECP256K1_PUBKEY + vault contract address").toBe(expectedAddress);
      logSkip("check/derive vault EVM address", `EVM_VAULT_ADDRESS is set correctly`);
      return;
    }
    env.EVM_VAULT_ADDRESS = expectedAddress;
    console.log(`derived a fresh EVM_VAULT_ADDRESS=${expectedAddress}`);
    console.log(` ➜ the vault's own EVM account (path "vault")`);
    console.log(` ➜ fund it with ETH for gas before running withdrawals`);
    console.log(` ➜ 💡 Set as EVM_VAULT_ADDRESS in the environment to skip this step on the next run`);
  });

  it("setup: check/derive user EVM address", () => {
    const identity = getUserIdentity(getCliConfig(env));
    const expectedAddress = deriveEvmAddress(
      requireEnv("MPC_SECP256K1_PUBKEY"),
      requireEnv("MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
      identity.commitmentHex,
    );
    if (env.EVM_USER_ADDRESS) {
      console.log(`Found EVM_USER_ADDRESS in the environment as ${env.EVM_USER_ADDRESS}`);
      expect(env.EVM_USER_ADDRESS, "EVM_USER_ADDRESS should be derived from MPC_SECP256K1_PUBKEY + vault contract + user identity").toBe(expectedAddress);
      logSkip("check/derive user EVM address", `EVM_USER_ADDRESS is set correctly`);
      return;
    }
    env.EVM_USER_ADDRESS = expectedAddress;
    console.log(`derived a fresh EVM_USER_ADDRESS=${expectedAddress}`);
    console.log(` ➜ the user's derived EVM account (path = identity commitment hex)`);
    console.log(` ➜ FUND IT ON EVM before the deposit test: >= 0.01 ETH (gas) and >= 0.1 USDC (deposit)`);
    console.log(` ➜ 💡 Set as EVM_USER_ADDRESS in the environment to skip this step on the next run`);
  });

  it("setup: print MPC server configuration", () => {
    const rootKey = env.MPC_ROOT_KEY ?? "(not derived here — already held by the server operator)";
    banner([
      "MPC (fakenet) server configuration — github.com/sig-net/solana-signet-program:",
      "",
      `  MPC_ROOT_KEY=${rootKey}`,
      `  MIDNIGHT_SIGNET_CONTRACT_ADDRESS=${requireEnv("MIDNIGHT_SIGNET_CONTRACT_ADDRESS")}`,
      "  # 💡 The responder now DISCOVERS requesters by watching this signet",
      "  #    contract's events — no requester contract list needed.",
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
  });

  // Wallet facade + cli context shared by every post-setup test. Built lazily
  // on first use — createCliContext needs the vault contract deployed, so this
  // can only run after the setup steps have populated env — and stopped once
  // in afterAll. Each access re-awaits synced state (instant when already
  // synced) so long tests / STEP_THROUGH pauses can't hand out a stale wallet.
  let sharedWallet: { facade: WalletFacade; context: CliContext } | undefined;

  async function sharedCliContext(): Promise<CliContext> {
    if (!sharedWallet) {
      const config = getCliConfig(env);
      const keys = deriveAccountKeys(config.userSeed, config.midnightNodeConfig.networkId);
      const facade = await initialiseWalletFacade(keys, config.midnightNodeConfig);
      await facade.start(keys.shieldedSecretKeys, keys.dustSecretKey);
      await facade.waitForSyncedState();
      sharedWallet = { facade, context: await createCliContext(config, { facade, keys }) };
    }
    await sharedWallet.facade.waitForSyncedState();
    return sharedWallet.context;
  }

  // MPC-style reader over the vault (requester) / signet contract pair, built
  // lazily on first use once the setup steps have populated the contract
  // addresses. Backed by a fresh indexerPublicDataProvider so it reads RAW
  // ledger state exactly as the response server does; it caches fetched request
  // records, so repeated lookups across tests cost one query each.
  let sharedReader: SignetRequestResponseReader | undefined;

  function sharedResponseReader(): SignetRequestResponseReader {
    if (!sharedReader) {
      const nodeConfig = getMidnightNodeConfig(env);
      sharedReader = new SignetRequestResponseReader({
        requesterContractAddress: requireEnv("MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
        signetContractAddress: requireEnv("MIDNIGHT_SIGNET_CONTRACT_ADDRESS"),
        publicDataProvider: indexerPublicDataProvider({
          queryURL: nodeConfig.indexerUrl,
          subscriptionURL: nodeConfig.indexerWsUrl,
        }),
      });
    }
    return sharedReader;
  }

  afterAll(async () => {
    await sharedWallet?.facade.stop().catch(() => { });
  });

  it(
    "initialize [erc-vault contract method call]: seal vault EVM address and read back state",
    async () => {
      const vaultEvmAddress = requireEnv("EVM_VAULT_ADDRESS");
      const context = await sharedCliContext();
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
  // It is populated by the requestDeposit test.
  let depositTransactionSignatureRequestId: RequestIdHex;

  it(
    "requestDeposit [erc-vault contract method call]: request a deposit through the cli and read it back MPC-style",
    async () => {
      // check if a request Id was given in then environment (for skipping steps during local development)
      if (env.DEPOSIT_REQUEST_ID) {
        depositTransactionSignatureRequestId = env.DEPOSIT_REQUEST_ID as RequestIdHex;
        logSkip("requestDeposit", `DEPOSIT_REQUEST_ID present in environment, skipping deposit call '${depositTransactionSignatureRequestId}'`);
        return;
      }

      const context = await sharedCliContext();

      // The sweep tx sender is the user's derived EVM account; its next nonce
      // comes from the chain, exactly as a wallet would fetch it.
      const evmNonce = await getTransactionNonce(requireEnv("EVM_RPC_URL"), requireEnv("EVM_USER_ADDRESS"));
      const amount = parseUnits("0.1", 6); // 0.1 USDC — the funding preflight's minimum

      depositTransactionSignatureRequestId = await requestDeposit(context, { amount, evmNonce });
      await readState(context);

      expect(depositTransactionSignatureRequestId).toMatch(/^[0-9a-f]{64}$/);

      // MPC-convention verification: fetch the request record the way the
      // response server does — through a SignetRequestResponseReader over RAW
      // contract state. getSignatureRequest throws when the id is absent, so a
      // returned record is itself proof the request landed on the vault ledger.
      const record = await sharedResponseReader().getSignatureRequest(
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
        "watches the signet contract's events and should pick it up on its next",
        "poll — resolving it from THIS vault's ledger — and sign the EVM tx.",
      ]);
    },
    5 * MINUTE,
  );

  it(
    "golden event: signet contract emitted a decodable SignBidirectionalEvent pointing at the vault",
    async () => {
      // Pins the SignBidirectionalEvent byte layout against a LIVE indexer —
      // the codec offsets (§signet-events.ts) depend on it, and gotcha #5 means
      // this cannot be exercised in the in-process simulator. The vault's
      // requestDeposit cross-contract-called the signet contract to emit this;
      // event indexing lags finalization, so poll (gotcha #15).
      expect(depositTransactionSignatureRequestId).toBeDefined();
      const vaultAddress = requireEnv("MIDNIGHT_VAULT_CONTRACT_ADDRESS");
      const signetAddress = requireEnv("MIDNIGHT_SIGNET_CONTRACT_ADDRESS");
      const nodeConfig = getMidnightNodeConfig(env);
      const pdp = indexerPublicDataProvider({
        queryURL: nodeConfig.indexerUrl,
        subscriptionURL: nodeConfig.indexerWsUrl,
      });

      const deadline = Date.now() + 60_000;
      let decoded: ReturnType<typeof decodeSignBidirectionalEvent> | undefined;
      let rawPayloadHex: string | undefined;
      while (Date.now() < deadline && decoded === undefined) {
        const events = await pdp.queryContractEvents({
          contractAddress: signetAddress,
          types: ["Misc"],
        });
        for (const event of events) {
          if (event.eventType !== "Misc") continue;
          if (eventNameTag(event.name) !== SIGN_BIDIRECTIONAL_EVENT_TAG) continue;
          const candidate = decodeSignBidirectionalEvent(hexToBytes(event.payload));
          if (candidate.requestId === depositTransactionSignatureRequestId) {
            decoded = candidate;
            rawPayloadHex = event.payload;
            break;
          }
        }
        if (decoded === undefined) await new Promise((r) => setTimeout(r, 1000));
      }

      if (decoded === undefined) {
        throw new Error(
          `no Misc "${SIGN_BIDIRECTIONAL_EVENT_TAG}" event for request ` +
            `${depositTransactionSignatureRequestId} indexed on ${signetAddress} within 60s`,
        );
      }

      // callerAddress points at the vault (the contract whose authenticated
      // ledger holds the request); requestId matches; the index is at field 0.
      expect(decoded.callerAddress).toBe(stripHexPrefix(vaultAddress).toLowerCase());
      expect(decoded.requestId).toBe(depositTransactionSignatureRequestId);
      expect(decoded.requestsIndexField).toBe(0);

      banner([
        "Golden SignBidirectionalEvent decoded from the live indexer:",
        "",
        `  callerAddress:      ${decoded.callerAddress}`,
        `  requestId:          ${decoded.requestId}`,
        `  requestsIndexField: ${decoded.requestsIndexField}`,
        "",
        `  raw payload (capture as the unit fixture if the layout ever drifts):`,
        `  ${rawPayloadHex}`,
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

      const context = await sharedCliContext();
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
    "golden event: signet contract emitted a decodable SignatureRespondedEvent for the posted response",
    async () => {
      // Pins the SignatureRespondedEvent byte layout against a LIVE indexer —
      // the codec offsets (§signet-events.ts) depend on it, and gotcha #5 means
      // this cannot be exercised in the in-process simulator. The MPC's
      // postSignatureResponse emitted this; pollSignatureResponse already
      // consumed it through the SignetResponseFeed, so it must be indexed —
      // still poll briefly to be robust against indexer lag (gotcha #15).
      expect(depositTransactionSignatureRequestId).toBeDefined();
      const signetAddress = requireEnv("MIDNIGHT_SIGNET_CONTRACT_ADDRESS");
      const nodeConfig = getMidnightNodeConfig(env);
      const pdp = indexerPublicDataProvider({
        queryURL: nodeConfig.indexerUrl,
        subscriptionURL: nodeConfig.indexerWsUrl,
      });

      const deadline = Date.now() + 60_000;
      let decoded: ReturnType<typeof decodeSignatureRespondedEvent> | undefined;
      let rawPayloadHex: string | undefined;
      while (Date.now() < deadline && decoded === undefined) {
        const events = await pdp.queryContractEvents({
          contractAddress: signetAddress,
          types: ["Misc"],
        });
        for (const event of events) {
          if (event.eventType !== "Misc") continue;
          if (eventNameTag(event.name) !== SIGNATURE_RESPONDED_EVENT_TAG) continue;
          const candidate = decodeSignatureRespondedEvent(hexToBytes(event.payload));
          // Take the request's FIRST post (count 0) so the assertion is stable
          // on reruns even if noise posts were added later.
          if (candidate.requestId === depositTransactionSignatureRequestId && candidate.count === 0n) {
            decoded = candidate;
            rawPayloadHex = event.payload;
            break;
          }
        }
        if (decoded === undefined) await new Promise((r) => setTimeout(r, 1000));
      }

      if (decoded === undefined) {
        throw new Error(
          `no Misc "${SIGNATURE_RESPONDED_EVENT_TAG}" event for request ` +
            `${depositTransactionSignatureRequestId} (count 0) indexed on ${signetAddress} within 60s`,
        );
      }

      expect(decoded.requestId).toBe(depositTransactionSignatureRequestId);
      expect(decoded.count).toBe(0n);

      banner([
        "Golden SignatureRespondedEvent decoded from the live indexer:",
        "",
        `  requestId: ${decoded.requestId}`,
        `  count:     ${decoded.count}`,
        "",
        `  raw payload (capture as the unit fixture if the layout ever drifts):`,
        `  ${rawPayloadHex}`,
      ]);
    },
    2 * MINUTE,
  );

  it(
    "broadcast deposit sweep evm txn: broadcase to evm",
    async () => {
      // confirm depositSweepTxn set in previous test after successful deploy request
      expect(signedDepositSweepTransaction).toBeDefined();

      const context = await sharedCliContext();
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

      const context = await sharedCliContext();
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
    "golden event: signet contract emitted a decodable RespondBidirectionalEvent for the stored attestation",
    async () => {
      // Pins the RespondBidirectionalEvent byte layout against a LIVE indexer —
      // the codec offsets (§signet-events.ts) depend on it, and gotcha #5 means
      // this cannot be exercised in the in-process simulator. The MPC's
      // postRespondBidirectional emitted this; pollRespondBidirectional already
      // consumed it through the SignetRespondBidirectionalFeed, so it must be
      // indexed — still poll briefly to be robust against indexer lag
      // (gotcha #15).
      expect(depositTransactionSignatureRequestId).toBeDefined();
      const signetAddress = requireEnv("MIDNIGHT_SIGNET_CONTRACT_ADDRESS");
      const nodeConfig = getMidnightNodeConfig(env);
      const pdp = indexerPublicDataProvider({
        queryURL: nodeConfig.indexerUrl,
        subscriptionURL: nodeConfig.indexerWsUrl,
      });

      const deadline = Date.now() + 60_000;
      let decoded: ReturnType<typeof decodeRespondBidirectionalEvent> | undefined;
      let rawPayloadHex: string | undefined;
      let observedCount = 0;
      while (Date.now() < deadline && decoded === undefined) {
        const events = await pdp.queryContractEvents({
          contractAddress: signetAddress,
          types: ["Misc"],
        });
        observedCount = 0;
        for (const event of events) {
          if (event.eventType !== "Misc") continue;
          if (eventNameTag(event.name) !== RESPOND_BIDIRECTIONAL_EVENT_TAG) continue;
          const candidate = decodeRespondBidirectionalEvent(hexToBytes(event.payload));
          if (candidate.requestId !== depositTransactionSignatureRequestId) continue;
          observedCount += 1;
          decoded = candidate;
          rawPayloadHex = event.payload;
        }
        if (decoded === undefined) await new Promise((r) => setTimeout(r, 1000));
      }

      if (decoded === undefined) {
        throw new Error(
          `no Misc "${RESPOND_BIDIRECTIONAL_EVENT_TAG}" event for request ` +
            `${depositTransactionSignatureRequestId} indexed on ${signetAddress} within 60s`,
        );
      }

      expect(decoded.requestId).toBe(depositTransactionSignatureRequestId);
      // At most once per request: the index holds one authenticated slot
      // (first valid write wins; a re-post is a no-op that emits nothing).
      expect(observedCount).toBe(1);

      banner([
        "Golden RespondBidirectionalEvent decoded from the live indexer:",
        "",
        `  requestId: ${decoded.requestId}`,
        "",
        `  raw payload (capture as the unit fixture if the layout ever drifts):`,
        `  ${rawPayloadHex}`,
      ]);
    },
    2 * MINUTE,
  );

  it(
    "claimDeposit [erc-vault contract method call]: verify the MPC attestation in-circuit and consume the request",
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

      const context = await sharedCliContext();
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
      // this request the entry is gone and claimDeposit would reject with
      // "Request not found" — skip cleanly instead.
      if (!(await isRequestOnLedger())) {
        logSkip("claimDeposit", `request ${depositTransactionSignatureRequestId} already claimed (not on the ledger)`);
        return;
      }

      await claimDeposit(context, { requestId: depositTransactionSignatureRequestId });
      await readState(context);

      expect(
        await isRequestOnLedger(),
        "claimDeposit must consume the request from the ledger",
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

  // Populated by the requestWithdraw test (or WITHDRAW_REQUEST_ID) for the
  // subsequent withdraw stages.
  let withdrawTransactionSignatureRequestId: RequestIdHex;

  it(
    "requestWithdraw [erc-vault contract method call]: escrow shielded vault tokens and read the request back MPC-style",
    async () => {
      // check if a request Id was given in the environment (for skipping steps during local development)
      if (env.WITHDRAW_REQUEST_ID) {
        withdrawTransactionSignatureRequestId = env.WITHDRAW_REQUEST_ID as RequestIdHex;
        logSkip("requestWithdraw", `WITHDRAW_REQUEST_ID present in environment, skipping withdraw call '${withdrawTransactionSignatureRequestId}'`);
        return;
      }

      const context = await sharedCliContext();

      // The withdraw tx sender is the VAULT's derived EVM account; its next
      // nonce comes from the chain, exactly as a wallet would fetch it. The
      // destination is the user's derived account, so the suite's funds cycle.
      const evmNonce = await getTransactionNonce(requireEnv("EVM_RPC_URL"), requireEnv("EVM_VAULT_ADDRESS"));
      const destEvmAddress = requireEnv("EVM_USER_ADDRESS");

      withdrawTransactionSignatureRequestId = await requestWithdraw(context, {
        amount: WITHDRAW_AMOUNT,
        destEvmAddress,
        evmNonce,
      });
      await readState(context);

      expect(withdrawTransactionSignatureRequestId).toMatch(/^[0-9a-f]{64}$/);

      // MPC-convention verification: the request resolves from RAW vault
      // state through the same reader the response server uses — recorded
      // under the VAULT's derivation path, with contract-built calldata.
      const record = await sharedResponseReader().getSignatureRequest(
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
    "watch withdraw signature request: signet contract emitted a SignBidirectionalEvent for the withdraw request",
    async () => {
      // The same watch the MPC runs for discovery: requestWithdraw
      // cross-contract-called the signet contract to emit this. Event indexing
      // lags finalization, so poll (gotcha #15).
      expect(withdrawTransactionSignatureRequestId).toBeDefined();
      const vaultAddress = requireEnv("MIDNIGHT_VAULT_CONTRACT_ADDRESS");
      const signetAddress = requireEnv("MIDNIGHT_SIGNET_CONTRACT_ADDRESS");
      const nodeConfig = getMidnightNodeConfig(env);
      const pdp = indexerPublicDataProvider({
        queryURL: nodeConfig.indexerUrl,
        subscriptionURL: nodeConfig.indexerWsUrl,
      });

      const deadline = Date.now() + 60_000;
      let decoded: ReturnType<typeof decodeSignBidirectionalEvent> | undefined;
      while (Date.now() < deadline && decoded === undefined) {
        const events = await pdp.queryContractEvents({
          contractAddress: signetAddress,
          types: ["Misc"],
        });
        for (const event of events) {
          if (event.eventType !== "Misc") continue;
          if (eventNameTag(event.name) !== SIGN_BIDIRECTIONAL_EVENT_TAG) continue;
          const candidate = decodeSignBidirectionalEvent(hexToBytes(event.payload));
          if (candidate.requestId === withdrawTransactionSignatureRequestId) {
            decoded = candidate;
            break;
          }
        }
        if (decoded === undefined) await new Promise((r) => setTimeout(r, 1000));
      }

      if (decoded === undefined) {
        throw new Error(
          `no Misc "${SIGN_BIDIRECTIONAL_EVENT_TAG}" event for withdraw request ` +
            `${withdrawTransactionSignatureRequestId} indexed on ${signetAddress} within 60s`,
        );
      }

      expect(decoded.callerAddress).toBe(stripHexPrefix(vaultAddress).toLowerCase());
      expect(decoded.requestsIndexField).toBe(0);

      banner([
        "SignBidirectionalEvent observed for the withdraw request:",
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

      const context = await sharedCliContext();
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
      const context = await sharedCliContext();

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

      const context = await sharedCliContext();
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

      const context = await sharedCliContext();
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
      if (!before.refundRecipient.member(requestKey)) {
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
        after.refundRecipient.member(requestKey),
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
