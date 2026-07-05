// The ordered e2e pipeline: environment check → setup (compile, deploy,
// derive keys/addresses, MPC hand-off printout) → initialization → deposit.
// One file ON PURPOSE: vitest runs same-file tests sequentially, and the
// setup steps feed each other through the env accumulator below. Run with
// `npm run test:integration` from the repo root (--bail stops the pipeline
// at the first failure); without RUN_INTEGRATION_TESTS the whole suite
// skips so plain `npm run test` stays offline.
//
// Tests drive the vault THROUGH the cli's exported command functions
// (AGENTS.md: orchestration lives in the cli, never in tests).

import {
  createCliContext,
  getCliConfig,
  getUserIdentity,
  initialize,
  readState,
  requestDeposit,
  requireConfigValue,
} from "@midnight-erc20-vault/cli";
import { deriveAccountKeys, getDeployConfig, getMidnightNodeConfig, withSyncedWalletFacade } from "@midnight-erc20-vault/lib";
import {
  bytesToBigint,
  deriveEvmAddress,
  deriveMpcKeys,
  generateMpcRootKey,
  readSignetEVMSignatureRequestIndexFromState,
} from "@midnight-erc20-vault/signet-midnight";
import { deployVault, ledger } from "@midnight-erc20-vault/vault-contract";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { parseEther, parseUnits } from "ethers";
import { describe, expect, it } from "vitest";

import { loadRepoDotEnv } from "../src/env-file.ts";
import { assertCommandAvailable, assertHttpReachable } from "../src/preflight.ts";
import { getErc20Balance, getEthBalance, getTransactionNonce, SEPOLIA_USDC_ADDRESS } from "../src/sepolia.ts";
import { runRootScript } from "../src/subprocess.ts";

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

/** The env keys the setup steps populate, in pipeline order. */
const PIPELINE_KEYS = [
  "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
  "MPC_ROOT_KEY",
  "MPC_JUBJUB_PK_X",
  "MPC_JUBJUB_PK_Y",
  "MPC_SECP256K1_PUBKEY",
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

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault e2e", () => {
  it(
    "environment: midnight stack reachable, compact on PATH, SEPOLIA_RPC_URL set",
    async () => {
      const nodeConfig = getMidnightNodeConfig(env);
      await assertHttpReachable("midnight node", new URL("/health", nodeConfig.nodeUrl).href);
      await assertHttpReachable("indexer", nodeConfig.indexerUrl);
      await assertHttpReachable("proof server", nodeConfig.proofServerUrl);
      await assertCommandAvailable("compact", ["--version"]);
      requireEnv("SEPOLIA_RPC_URL");

      const deployConfig = getDeployConfig(env);
      const cliConfig = getCliConfig(env);
      console.log(`DEPLOYER_SEED in effect: ${deployConfig.deployerSeed}`);
      console.log(`USER_SEED in effect:     ${cliConfig.userSeed}`);
    },
    MINUTE,
  );

  it(
    "setup: compile vault contract with proving keys",
    async () => {
      if (env.MIDNIGHT_VAULT_CONTRACT_ADDRESS) {
        logSkip("compile:vault:zk", `MIDNIGHT_VAULT_CONTRACT_ADDRESS is set (${env.MIDNIGHT_VAULT_CONTRACT_ADDRESS})`);
        return;
      }
      await runRootScript("compile:vault:zk", env, 14 * MINUTE);
    },
    15 * MINUTE,
  );

  it(
    "setup: deploy vault contract",
    async () => {
      if (env.MIDNIGHT_VAULT_CONTRACT_ADDRESS) {
        logSkip("deploy:vault", `MIDNIGHT_VAULT_CONTRACT_ADDRESS is set (${env.MIDNIGHT_VAULT_CONTRACT_ADDRESS})`);
        return;
      }
      const { contractAddress } = await deployVault(env);
      env.MIDNIGHT_VAULT_CONTRACT_ADDRESS = contractAddress;
      banner([
        `MIDNIGHT_VAULT_CONTRACT_ADDRESS=${contractAddress}`,
        "",
        "Add this to your .env to skip compile + deploy on subsequent runs.",
      ]);
    },
    10 * MINUTE,
  );

  it("setup: derive MPC root key", () => {
    if (env.MPC_ROOT_KEY) {
      logSkip("derive MPC root key", "MPC_ROOT_KEY is set");
      return;
    }
    env.MPC_ROOT_KEY = generateMpcRootKey();
    console.log("generated a fresh MPC_ROOT_KEY (printed in the MPC server configuration step)");
  });

  it("setup: derive MPC public keys", () => {
    if (env.MPC_JUBJUB_PK_X && env.MPC_JUBJUB_PK_Y && env.MPC_SECP256K1_PUBKEY) {
      logSkip("derive MPC public keys", "MPC_JUBJUB_PK_X/Y and MPC_SECP256K1_PUBKEY are set");
      return;
    }
    const keys = deriveMpcKeys(requireEnv("MPC_ROOT_KEY"));
    env.MPC_JUBJUB_PK_X = keys.jubjubPkX.toString();
    env.MPC_JUBJUB_PK_Y = keys.jubjubPkY.toString();
    env.MPC_SECP256K1_PUBKEY = keys.secp256k1CompressedPubkey;
    console.log(`MPC_JUBJUB_PK_X=${env.MPC_JUBJUB_PK_X}`);
    console.log(`MPC_JUBJUB_PK_Y=${env.MPC_JUBJUB_PK_Y}`);
    console.log(`MPC_SECP256K1_PUBKEY=${env.MPC_SECP256K1_PUBKEY}`);
  });

  it("setup: derive vault EVM address", () => {
    if (env.EVM_VAULT_ADDRESS) {
      logSkip("derive vault EVM address", `EVM_VAULT_ADDRESS is set (${env.EVM_VAULT_ADDRESS})`);
      return;
    }
    const address = deriveEvmAddress(
      requireEnv("MPC_SECP256K1_PUBKEY"),
      requireEnv("MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
      "vault",
    );
    env.EVM_VAULT_ADDRESS = address;
    banner([
      `EVM_VAULT_ADDRESS=${address}`,
      "",
      "The vault's own EVM account (path \"vault\"). Add to your .env to skip",
      "this derivation; fund it with ETH for gas before running withdrawals.",
    ]);
  });

  it("setup: derive user EVM address", () => {
    if (env.EVM_USER_ADDRESS) {
      logSkip("derive user EVM address", `EVM_USER_ADDRESS is set (${env.EVM_USER_ADDRESS})`);
      return;
    }
    const identity = getUserIdentity(getCliConfig(env));
    const address = deriveEvmAddress(
      requireEnv("MPC_SECP256K1_PUBKEY"),
      requireEnv("MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
      identity.commitmentHex,
    );
    env.EVM_USER_ADDRESS = address;
    banner([
      `EVM_USER_ADDRESS=${address}`,
      "",
      "The user's derived EVM account (path = identity commitment hex).",
      "Add to your .env to skip this derivation. FUND IT ON SEPOLIA before",
      "the deposit test: >= 0.01 ETH (gas) and >= 0.1 USDC (deposit).",
    ]);
  });

  it("setup: print MPC server configuration", () => {
    const rootKey = env.MPC_ROOT_KEY ?? "(not derived here — already held by the server operator)";
    banner([
      "MPC (fakenet) server configuration — github.com/sig-net/solana-signet-program:",
      "",
      `  MPC_ROOT_KEY=${rootKey}`,
      `  MIDNIGHT_CONTRACT_ADDRESSES=${requireEnv("MIDNIGHT_VAULT_CONTRACT_ADDRESS")}`,
      "  (comma-separated if more contracts are added later)",
      "",
      "Set those in the server's .env, then START THE SERVER: `yarn response`",
      "in the solana-signet-program repo. The e2e deposit/withdraw flows need",
      "it running.",
      "",
      "Minimal .env block for this suite:",
      "",
      ...PIPELINE_KEYS.map((key) => `  ${key}=${env[key] ?? ""}`),
      `  SEPOLIA_RPC_URL=${env.SEPOLIA_RPC_URL ?? ""}`,
    ]);
  });

  it(
    "initialize: seal vault EVM address and read back state",
    async () => {
      const config = getCliConfig(env);
      const vaultContractAddress = requireConfigValue(config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
      const vaultEvmAddress = requireEnv("EVM_VAULT_ADDRESS");

      const keys = deriveAccountKeys(config.userSeed, config.midnightNodeConfig.networkId);
      await withSyncedWalletFacade(keys, config.midnightNodeConfig, async (facade) => {
        const context = await createCliContext(config, { facade, keys });

        const readLedger = async () => {
          const contractState = await context.providers.publicDataProvider.queryContractState(vaultContractAddress);
          if (!contractState) {
            throw new Error(`no contract state found at ${vaultContractAddress}`);
          }
          return ledger(contractState.data);
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
      });
    },
    15 * MINUTE,
  );

  it(
    "deposit: user EVM account funding preflight",
    async () => {
      const rpcUrl = requireEnv("SEPOLIA_RPC_URL");
      const userAddress = requireEnv("EVM_USER_ADDRESS");
      const erc20Address = env.ERC20_ADDRESS ?? SEPOLIA_USDC_ADDRESS;

      const ethBalance = await getEthBalance(rpcUrl, userAddress);
      console.log(`${userAddress} ETH balance: ${ethBalance} wei`);
      expect(ethBalance, `fund ${userAddress} with >= 0.01 ETH on Sepolia`).toBeGreaterThanOrEqual(
        parseEther("0.01"),
      );

      const { balance, decimals } = await getErc20Balance(rpcUrl, erc20Address, userAddress);
      console.log(`${userAddress} balance on ${erc20Address}: ${balance} (decimals ${decimals})`);
      expect(balance, `fund ${userAddress} with >= 0.1 of ERC20 ${erc20Address} on Sepolia`).toBeGreaterThanOrEqual(
        parseUnits("0.1", decimals),
      );
    },
    MINUTE,
  );

  it(
    "deposit: request a deposit through the cli and read it back MPC-style",
    async () => {
      // The cli needs the EVM-side config; default what the pipeline hasn't
      // pinned (Sepolia + canonical USDC, matching the funding preflight).
      env.ERC20_ADDRESS ??= SEPOLIA_USDC_ADDRESS;
      env.EVM_CHAIN_ID ??= "11155111";

      const config = getCliConfig(env);
      const vaultContractAddress = requireConfigValue(config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");

      // The sweep tx sender is the user's derived EVM account; its next nonce
      // comes from the chain, exactly as a wallet would fetch it.
      const evmNonce = await getTransactionNonce(requireEnv("SEPOLIA_RPC_URL"), requireEnv("EVM_USER_ADDRESS"));
      const amount = parseUnits("0.1", 6); // 0.1 USDC — the funding preflight's minimum

      const keys = deriveAccountKeys(config.userSeed, config.midnightNodeConfig.networkId);
      const requestId = await withSyncedWalletFacade(keys, config.midnightNodeConfig, async (facade) => {
        const context = await createCliContext(config, { facade, keys });
        const id = await requestDeposit(context, { amount, evmNonce });
        await readState(context);
        return id;
      });

      expect(requestId).toMatch(/^[0-9a-f]{64}$/);

      // MPC-convention verification: decode the request index from RAW
      // contract state (field 0, no compiled contract) — the exact read the
      // response server performs — and find the request under its id.
      const nodeConfig = getMidnightNodeConfig(env);
      const publicDataProvider = indexerPublicDataProvider(nodeConfig.indexerUrl, nodeConfig.indexerWsUrl);
      const contractState = await publicDataProvider.queryContractState(vaultContractAddress);
      expect(contractState).toBeTruthy();
      const rawIndex = readSignetEVMSignatureRequestIndexFromState(contractState!.data);
      expect([...rawIndex.keys()]).toContain(requestId);

      const record = rawIndex.get(requestId)!;
      expect(record.evmTransaction.nonce).toBe(evmNonce);
      expect(bytesToBigint(record.calldata.args[1])).toBe(amount);

      banner([
        `Deposit request recorded on the vault ledger:`,
        "",
        `  request id: ${requestId}`,
        "",
        "The response server (yarn response, MIDNIGHT_CONTRACT_ADDRESSES set to",
        "this vault) should pick it up on its next poll and sign the EVM tx.",
      ]);
    },
    15 * MINUTE,
  );
});
