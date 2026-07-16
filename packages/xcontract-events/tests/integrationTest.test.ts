// End-to-end proof that THIS repo's stack really does cross-contract calls +
// events on a live Midnight network: deploy token (B) → deploy vault (A,
// referencing B) → call vault.depositViaVault(amount) → observe that the call
// reached B (B's ledger mutated) and that A's own state advanced.
//
// The chain of custody for the two features:
//   • Cross-contract: depositViaVault does nothing to B's ledger locally — the
//     only way B.depositCount increments and B.lastAmount becomes `amount` is
//     if the single submitted transaction carried a proven call into B. So a
//     mutated token ledger IS the cross-contract call landing on-chain.
//   • Events: B.deposit emits the custom `Misc`(deposit) event as part of that
//     same call. Its execution is inseparable from the ledger mutation we
//     assert. (Reading the event back off the indexer's event stream is a
//     further step not wired here — the ledger delta is the on-chain proof the
//     emit path ran under real proving.)
//
// Env-gated exactly like the vault e2e: skips entirely unless
// RUN_INTEGRATION_TESTS is set, so the offline `yarn test` stays green. Needs a
// running node + indexer + proof server (the deploy package's Midnight node config env) and a
// funded DEPLOYER_SEED wallet. One file on purpose: vitest runs same-file
// tests sequentially and the steps feed each other through the `env`
// accumulator (set XC_TOKEN_CONTRACT_ADDRESS / XC_VAULT_CONTRACT_ADDRESS to
// resume against already-deployed contracts).

import {
  deriveAccountKeys,
  getDeployConfig,
  getMidnightNodeConfig,
  initialiseWalletFacade,
  type WalletFacade,
} from "@sig-net/midnight-contract-deploy";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js/contracts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js/network-id";
import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js-types";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildVaultProviders,
  createVaultPrivateState,
  deployToken,
  deployVault,
  Token,
  vaultCompiledContract,
  Vault,
  VAULT_PRIVATE_STATE_ID,
} from "../src/index.ts";

const MINUTE = 60_000;

// Seeded from the real environment; populated by the setup steps.
const env: NodeJS.ProcessEnv = { ...process.env };

const DEPOSIT_AMOUNT = 4242n;

/** Assert a prior step (or the environment) populated `name`. */
function requireEnv(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set — did the step that derives it run?`);
  return value;
}

function logSkip(step: string, reason: string): void {
  console.log(`SKIPPED: ${step} — ${reason}`);
}

async function assertHttpReachable(label: string, url: string): Promise<void> {
  try {
    await fetch(url, { method: "GET" });
  } catch (cause) {
    throw new Error(`${label} not reachable at ${url}`, { cause });
  }
}

/** Read + decode a contract's ledger from raw indexer state. */
async function queryLedger<L>(
  pdp: PublicDataProvider,
  address: string,
  decode: (data: Parameters<typeof Token.ledger>[0]) => L,
): Promise<L> {
  const state = await pdp.queryContractState(address);
  if (!state) throw new Error(`no contract state found at ${address}`);
  return decode(state.data);
}

const stripHex = (hex: string): string => (hex.startsWith("0x") ? hex.slice(2) : hex);
const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(stripHex(hex), "hex"));
/** ascii text of a zero-padded Bytes<N> tag (the `pad(N, "...")` convention). */
const asciiTag = (hex: string): string => Buffer.from(hexToBytes(hex)).toString("latin1").replace(/\0+$/, "");
/** Little-endian bigint of a byte slice (the serialize<> field convention). */
const leBigint = (b: Uint8Array): bigint => {
  let r = 0n;
  for (let i = b.length - 1; i >= 0; i--) r = (r << 8n) | BigInt(b[i]);
  return r;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("xcontract-events e2e", () => {
  const nodeConfig = () => getMidnightNodeConfig(env);

  // A fresh indexer public-data provider for reading raw ledger state.
  let sharedPdp: PublicDataProvider | undefined;
  const publicDataProvider = (): PublicDataProvider => {
    if (!sharedPdp) {
      const cfg = nodeConfig();
      sharedPdp = indexerPublicDataProvider({ queryURL: cfg.indexerUrl, subscriptionURL: cfg.indexerWsUrl });
    }
    return sharedPdp;
  };

  // Deployer wallet, opened once and reused across the call step.
  let sharedWallet: { facade: WalletFacade; keys: ReturnType<typeof deriveAccountKeys> } | undefined;
  async function wallet() {
    if (!sharedWallet) {
      const cfg = getDeployConfig(env);
      const keys = deriveAccountKeys(cfg.deployerSeed, cfg.midnightNodeConfig.networkId);
      setNetworkId(cfg.midnightNodeConfig.networkId);
      const facade = await initialiseWalletFacade(keys, cfg.midnightNodeConfig);
      await facade.start(keys.shieldedSecretKeys, keys.dustSecretKey);
      await facade.waitForSyncedState();
      sharedWallet = { facade, keys };
    }
    await sharedWallet.facade.waitForSyncedState();
    return sharedWallet;
  }

  afterAll(async () => {
    await sharedWallet?.facade.stop().catch(() => {});
  });

  it(
    "environment: midnight node, indexer and proof server reachable",
    async () => {
      const cfg = nodeConfig();
      await assertHttpReachable("midnight node", new URL("/health", cfg.nodeUrl).href);
      await assertHttpReachable("indexer", cfg.indexerUrl);
      await assertHttpReachable("proof server", cfg.proofServerUrl);
    },
    MINUTE,
  );

  it(
    "deploy token (B, the callee)",
    async () => {
      if (env.XC_TOKEN_CONTRACT_ADDRESS) {
        logSkip("deploy token", `XC_TOKEN_CONTRACT_ADDRESS is set (${env.XC_TOKEN_CONTRACT_ADDRESS})`);
        return;
      }
      const { contractAddress } = await deployToken(env);
      env.XC_TOKEN_CONTRACT_ADDRESS = contractAddress;
      console.log(`deployed token at ${contractAddress}`);
    },
    10 * MINUTE,
  );

  it(
    "deploy vault (A, the caller) referencing the token",
    async () => {
      if (env.XC_VAULT_CONTRACT_ADDRESS) {
        logSkip("deploy vault", `XC_VAULT_CONTRACT_ADDRESS is set (${env.XC_VAULT_CONTRACT_ADDRESS})`);
        return;
      }
      const { contractAddress } = await deployVault(requireEnv("XC_TOKEN_CONTRACT_ADDRESS"), env);
      env.XC_VAULT_CONTRACT_ADDRESS = contractAddress;
      console.log(`deployed vault at ${contractAddress}`);
    },
    10 * MINUTE,
  );

  // Chain tx id of the deposit call; set by the call step, read by the event
  // step to cross-check the event's origin.
  let depositTxId: string | undefined;

  it(
    "call vault.depositViaVault → cross-contract call reaches the token and emits its event",
    async () => {
      const tokenAddress = requireEnv("XC_TOKEN_CONTRACT_ADDRESS");
      const vaultAddress = requireEnv("XC_VAULT_CONTRACT_ADDRESS");
      const pdp = publicDataProvider();

      // Baseline: the token's deposit count before the call.
      const before = await queryLedger(pdp, tokenAddress, Token.ledger);
      console.log(`token.depositCount before: ${before.depositCount}`);

      // Join the deployed vault and fire the call. midnight-js auto-enables
      // cross-contract calls: it resolves the token's on-chain state at the
      // latest block and assembles ONE transaction proving both contracts'
      // calls (proving keys for both come from buildVaultProviders' registry).
      const { facade, keys } = await wallet();
      const providers = buildVaultProviders(facade, keys, nodeConfig());
      const vault = await findDeployedContract(providers, {
        contractAddress: vaultAddress,
        compiledContract: vaultCompiledContract,
        privateStateId: VAULT_PRIVATE_STATE_ID,
        initialPrivateState: createVaultPrivateState(),
      });

      const result = await vault.callTx.depositViaVault(DEPOSIT_AMOUNT);
      depositTxId = result.public.txId;
      console.log(`depositViaVault finalized in tx ${result.public.txId}`);

      // The token ledger moved — only possible if the cross-contract call
      // landed and executed B.deposit (which also emitted the event).
      const afterToken = await queryLedger(pdp, tokenAddress, Token.ledger);
      console.log(`token.depositCount after: ${afterToken.depositCount}, lastAmount: ${afterToken.lastAmount}`);
      expect(afterToken.depositCount).toBe(before.depositCount + 1n);
      expect(afterToken.lastAmount).toBe(DEPOSIT_AMOUNT);

      // And the vault advanced its own counter in the same transaction.
      const afterVault = await queryLedger(pdp, vaultAddress, Vault.ledger);
      console.log(`vault.vaultCallCount after: ${afterVault.vaultCallCount}`);
      expect(afterVault.vaultCallCount).toBeGreaterThanOrEqual(1n);
    },
    15 * MINUTE,
  );

  it(
    "read the emitted event off the indexer, decode it, and PROVE it valid + vault-submitted",
    async () => {
      const tokenAddress = requireEnv("XC_TOKEN_CONTRACT_ADDRESS");
      const vaultAddress = requireEnv("XC_VAULT_CONTRACT_ADDRESS");
      const pdp = publicDataProvider();

      // Poll the indexer's MIP-0002 contract-event stream for the token's
      // `Misc` events until our "deposit" event shows up (event indexing lags
      // block finalization slightly). This is the on-chain side of the emit:
      // B.deposit ran inside the cross-contract call and published this event.
      const deadline = Date.now() + 60_000;
      let depositEvent: Extract<Awaited<ReturnType<typeof pdp.queryContractEvents>>[number], { eventType: "Misc" }> | undefined;
      while (Date.now() < deadline) {
        const events = await pdp.queryContractEvents({ contractAddress: tokenAddress, types: ["Misc"] });
        const match = events.find((e) => e.eventType === "Misc" && asciiTag(e.name) === "deposit");
        if (match && match.eventType === "Misc") {
          depositEvent = match;
          break;
        }
        await sleep(1000);
      }

      if (!depositEvent) {
        throw new Error(`no Misc "deposit" event indexed for token ${tokenAddress} within 60s`);
      }

      // Decode the DepositEvent payload: serialize<DepositEvent, 256> laid out
      // amount (0..16 LE), sequence (16..24 LE), caller ContractAddress (24..56).
      const payload = hexToBytes(depositEvent.payload);
      const amount = leBigint(payload.slice(0, 16));
      const sequence = leBigint(payload.slice(16, 24));
      const callerBytes = payload.slice(24, 56);
      const callerHex = Buffer.from(callerBytes).toString("hex");
      console.log(
        `indexer event: id=${depositEvent.id} name="${asciiTag(depositEvent.name)}" ` +
          `amount=${amount} sequence=${sequence} caller=${callerHex} tx=${depositTxId ?? "(unknown)"}`,
      );

      expect(asciiTag(depositEvent.name)).toBe("deposit");
      expect(amount).toBe(DEPOSIT_AMOUNT);
      expect(sequence).toBe(0n); // first deposit against a freshly-deployed token
      // The event was published by the token we called; its self-described caller is the vault.
      expect(stripHex(depositEvent.contractAddress).toLowerCase()).toBe(stripHex(tokenAddress).toLowerCase());
      expect(callerHex.toLowerCase()).toBe(stripHex(vaultAddress).toLowerCase());

      // ── THE PROOF ─────────────────────────────────────────────────────────
      // Recompute the event id from its decoded fields (the token's own pure
      // circuit — same persistentHash(serialize(DepositEvent)) as on-chain), then
      // check it is a member of BOTH authenticated ledger sets:
      //   • token.emittedDeposits  → the token genuinely emitted this event
      //     (its ledger write is part of the ZK-proven transcript);
      //   • vault.vaultDeposits    → THIS vault triggered it — the hash the vault
      //     stored is exactly the token's return value, bound by the
      //     cross-contract communication commitment.
      // Both memberships holding ⟺ a valid event that the vault submitted by
      // calling the token. No signatures; no trust in the indexer beyond the
      // decoded fields (which we re-verify against authenticated state).
      const eventHash = Token.pureCircuits.depositEventHash(amount, sequence, { bytes: callerBytes });

      const tokenLedger = await queryLedger(pdp, tokenAddress, Token.ledger);
      const vaultLedger = await queryLedger(pdp, vaultAddress, Vault.ledger);

      const inToken = tokenLedger.emittedDeposits.member(eventHash);
      const inVault = vaultLedger.vaultDeposits.member(eventHash);
      console.log(`proof: eventHash=${Buffer.from(eventHash).toString("hex")} ∈ token.emittedDeposits=${inToken} ∈ vault.vaultDeposits=${inVault}`);

      expect(inToken).toBe(true);  // token really emitted it
      expect(inVault).toBe(true);  // vault really submitted it (bound cross-contract return)
    },
    5 * MINUTE,
  );
});
