// Seed → account construction utilities shared by every wallet host (the UI's
// SeedWallet and the integration tests' buildWallet): key derivation, address
// encoding and WalletFacade wiring. Pure crypto + facade construction — no
// network I/O happens here (the facade connects only when started).
import * as ledger from "@midnightntwrk/ledger-v9";
import { InMemoryTransactionHistoryStorage } from "@midnightntwrk/wallet-sdk-abstractions";
import {
  DustAddress,
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  UnshieldedAddress,
} from "@midnightntwrk/wallet-sdk-address-format";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import {
  type FacadeState,
  mergeWalletEntries,
  type TransactionIdentifier,
  WalletEntrySchema,
  WalletFacade,
} from "@midnightntwrk/wallet-sdk-facade";
import { HDWallet, Roles } from "@midnightntwrk/wallet-sdk-hd";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import {
  createKeystore,
  PublicKey as UnshieldedPublicKey,
  type UnshieldedKeystore,
  UnshieldedWallet,
} from "@midnightntwrk/wallet-sdk-unshielded-wallet";

import type { MidnightNodeConfig } from "./midnight-node-config.ts";
import type { NetworkId } from "./network-id.ts";
import { parseSeed } from "./seed.ts";

// Consumers hold facades/states we hand them without adding the wallet-sdk
// packages themselves — re-export the handle types alongside the builders.
export type {
  FacadeState,
  TransactionIdentifier,
  WalletFacade,
} from "@midnightntwrk/wallet-sdk-facade";
// The encryption-key string type of the shielded key pair consumers receive
// through AccountKeys (e.g. to address a mint to another wallet) —
// re-exported so they don't add the ledger package themselves.
export type { EncPublicKey } from "@midnightntwrk/ledger-v9";

/** The live key material for one account. Reused for signing / balancing. */
export interface AccountKeys {
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
}

/** A wallet's three Midnight addresses, as bech32m strings. */
export interface WalletAddresses {
  unshielded: string; // NIGHT receive address
  shielded: string;
  dust: string;
}

/**
 * Default `additionalFeeOverhead` the facade balances transactions with: it
 * burns `feesWithMargin(params, feeBlocksMargin) + additionalFeeOverhead`
 * per transaction, so the overhead is burned as dust on EVERY submitted
 * transaction.
 *
 * The overhead compensates for the wallet sdk pricing a PROOF-ERASED
 * transaction while the node prices the real proof bytes. The node's fee
 * consequently exceeds the wallet's estimate by an amount that grows with
 * proof size, and the node rejects the spend with
 * Malformed(BalanceCheckOverspend) when the wallet under-provides. 5e13
 * covers the gap this repo's circuits produce, with headroom, and the excess
 * is simply burned dust. The default is tuned for local fakenet chains where
 * dust is free: real-network deploys may want a lower value (see
 * {@link WalletFacadeOptions}).
 */
export const DEFAULT_ADDITIONAL_FEE_OVERHEAD = 50_000_000_000_000n;

// Fee margin in blocks the facade balances with, alongside the overhead.
const FEE_BLOCKS_MARGIN = 5;

/**
 * Optional tuning knobs for {@link initialiseWalletFacade} (and
 * {@link withSyncedWalletFacade}, which passes them through).
 */
export interface WalletFacadeOptions {
  /**
   * Flat fee overhead added on top of the estimated fee of every submitted
   * transaction, burned as dust each time. Defaults to
   * {@link DEFAULT_ADDITIONAL_FEE_OVERHEAD} (5e13), which is tuned for local
   * fakenet chains: real-network deploys may want it lower.
   */
  additionalFeeOverhead?: bigint;
}

/**
 * Parse a seed and derive the three role keys (Zswap / NightExternal / Dust).
 * Pure crypto — no network. This is the step that exercises the ledger WASM.
 *
 * @param seed - The wallet seed, as hex or a BIP-39 mnemonic.
 * @param networkId - The network the unshielded keystore is bound to.
 * @returns The Zswap, Dust and unshielded role keys.
 * @throws {Error} If the seed is rejected by the HD wallet or key derivation fails.
 */
export function deriveAccountKeys(seed: string, networkId: NetworkId): AccountKeys {
  const { seed: seedBytes } = parseSeed(seed);

  const hd = HDWallet.fromSeed(seedBytes);
  if (hd.type !== "seedOk") throw new Error("HDWallet.fromSeed failed (seedError).");

  const derived = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derived.type !== "keysDerived") throw new Error("deriveKeysAt failed (keyOutOfBounds).");
  hd.hdWallet.clear();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(
    { kind: "schnorr", secret: derived.keys[Roles.NightExternal] },
    networkId,
  );

  return { shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

/**
 * Compute the three bech32m addresses from the keys. Pure — no network.
 *
 * @param keys - The derived role keys.
 * @param networkId - The network the addresses are encoded for.
 * @returns The wallet's unshielded, shielded and dust addresses.
 */
export function deriveAddresses(keys: AccountKeys, networkId: NetworkId): WalletAddresses {
  const shieldedAddr = new ShieldedAddress(
    ShieldedCoinPublicKey.fromHexString(keys.shieldedSecretKeys.coinPublicKey),
    ShieldedEncryptionPublicKey.fromHexString(keys.shieldedSecretKeys.encryptionPublicKey),
  );
  return {
    unshielded: keys.unshieldedKeystore.getBech32Address().asString(),
    shielded: MidnightBech32m.encode(networkId, shieldedAddr).asString(),
    dust: DustAddress.encodePublicKey(networkId, keys.dustSecretKey.publicKey),
  };
}

/**
 * Wire up the WalletFacade for the given keys + connection config. This only
 * constructs the three sub-wallets — it does NOT start syncing.
 *
 * @param keys - The derived role keys the facade drives.
 * @param config - The endpoints the facade connects to.
 * @param options - Facade tuning; see {@link WalletFacadeOptions}.
 * @returns The constructed facade, not yet syncing.
 */
export function initialiseWalletFacade(
  keys: AccountKeys,
  config: MidnightNodeConfig,
  options: WalletFacadeOptions = {},
): Promise<WalletFacade> {
  return WalletFacade.init({
    configuration: {
      networkId: config.networkId,
      indexerClientConnection: {
        indexerHttpUrl: config.indexerUrl,
        indexerWsUrl: config.indexerWsUrl,
      },
      provingServerUrl: new URL(config.proofServerUrl),
      // The facade talks to the node over WebSocket, so flip http(s) -> ws(s).
      relayURL: new URL(config.nodeUrl.replace(/^http/, "ws")),
      costParameters: {
        additionalFeeOverhead: options.additionalFeeOverhead ?? DEFAULT_ADDITIONAL_FEE_OVERHEAD,
        feeBlocksMargin: FEE_BLOCKS_MARGIN,
      },
      txHistoryStorage: new InMemoryTransactionHistoryStorage(
        WalletEntrySchema,
        mergeWalletEntries,
      ),
    },
    shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(keys.shieldedSecretKeys),
    unshielded: (cfg) =>
      UnshieldedWallet(cfg).startWithPublicKey(
        UnshieldedPublicKey.fromKeyStore(keys.unshieldedKeystore),
      ),
    dust: (cfg) =>
      DustWallet(cfg).startWithSecretKey(
        keys.dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
      ),
  });
}

// Recipes (balancing plans for submitted transactions) expire 30 min out.
const RECIPE_TTL_MS = 30 * 60 * 1000;

// Balancing throws Wallet.InsufficientFunds ("could not balance dust") while
// the paying wallet's DUST is still generating: a young local chain accrues
// it block by block from the genesis NIGHT, and a freshly registered wallet
// on a deployed network starts from its first few units. Building the recipe
// costs no proving, so it is retried in place until the wallet covers the
// fee. A wallet with nothing to generate from fails fast in ensureFeeReady
// (funding.ts) before any of this, so the bounded retry cannot mask real
// underfunding.
const BALANCE_RETRY_INTERVAL_MS = 15_000;
const BALANCE_RETRY_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * Run a recipe-building call, retrying while it fails for lack of DUST. Each
 * retry first waits for the facade to report itself synced again, so the
 * balancer works from the chain tip rather than the view the last attempt
 * failed on.
 *
 * @param facade - The started facade `build` balances with.
 * @param build - The balancing call to (re)attempt.
 * @returns The recipe `build` resolves to.
 * @throws {Error} The last error once {@link BALANCE_RETRY_TIMEOUT_MS} is
 *   spent, or immediately for any error other than insufficient dust.
 */
async function balanceWhileDustGenerates<T>(
  facade: WalletFacade,
  build: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + BALANCE_RETRY_TIMEOUT_MS;
  for (;;) {
    try {
      return await build();
    } catch (error) {
      const message = String(error);
      const insufficientDust =
        message.includes("InsufficientFunds") || message.includes("could not balance dust");
      if (!insufficientDust || Date.now() >= deadline) throw error;
      console.log(
        `the wallet cannot cover the fee yet (DUST still generating), retrying in ${String(BALANCE_RETRY_INTERVAL_MS / 1000)}s`,
      );
      await new Promise((resolve) => setTimeout(resolve, BALANCE_RETRY_INTERVAL_MS));
      const state = await facade.waitForSyncedState();
      console.log(`wallet resynced, spendable DUST: ${String(state.dust.balance(new Date()))}`);
    }
  }
}

/**
 * Balance, sign, prove and submit a serialized unproven transaction (e.g. a
 * contract deploy built by `buildDeployTransaction` in deploy.ts). Proving
 * happens in `finalizeRecipe` via the facade's configured proof server.
 *
 * @param facade - A started (and synced) wallet facade that pays for and submits the transaction.
 * @param keys - The key material of the same wallet, for balancing and signing.
 * @param serializedTransaction - The unproven transaction bytes.
 * @returns The submitted transaction's identifier.
 * @throws {Error} If the wallet still cannot cover fees after the balancing retry
 *   budget, proving fails, or the node rejects the transaction.
 */
export async function submitUnprovenTransaction(
  facade: WalletFacade,
  keys: AccountKeys,
  serializedTransaction: Uint8Array,
): Promise<TransactionIdentifier> {
  // Deserialize back into the ledger UnprovenTransaction the facade balances.
  const tx = ledger.Transaction.deserialize<
    ledger.SignatureEnabled,
    ledger.PreProof,
    ledger.PreBinding
  >("signature", "pre-proof", "pre-binding", serializedTransaction);

  // Balance (add dust/fee inputs) → sign those inputs → finalize (prove) → submit.
  console.log("balancing and signing transaction...");
  const recipe = await balanceWhileDustGenerates(facade, () =>
    facade.balanceUnprovenTransaction(
      tx,
      { shieldedSecretKeys: keys.shieldedSecretKeys, dustSecretKey: keys.dustSecretKey },
      { ttl: new Date(Date.now() + RECIPE_TTL_MS) },
    ),
  );
  const signed = await facade.signRecipe(recipe, keys.unshieldedKeystore.signDataAsync);
  console.log("proving transaction (proof server, can take minutes)...");
  const finalized = await facade.finalizeRecipe(signed);
  console.log("submitting transaction...");
  return facade.submitTransaction(finalized);
}

/**
 * Transfer unshielded NIGHT from a started wallet to another wallet's
 * unshielded (NIGHT receive) address: build the transfer recipe, sign its
 * inputs, prove, and submit. Fees are paid in the sender's DUST (`payFees`),
 * so the sender must already be dust-generating. The NIGHT token type is read
 * from the sender's synced state (these chains carry a single unshielded
 * token), so no token constant is hard-coded.
 *
 * @param facade - A started, synced, dust-generating wallet facade (the funder).
 * @param keys - The funder's key material, for balancing and signing.
 * @param state - The funder's synced state, read for its NIGHT token type.
 * @param toUnshieldedAddress - The recipient's unshielded address (bech32m, network-prefixed).
 * @param networkId - The network both wallets live on (decodes the address).
 * @param amount - NIGHT to send, in base units.
 * @returns The submitted transaction's identifier.
 * @throws {Error} If the sender holds no unshielded NIGHT, or balancing/proving/submission fails.
 */
export async function transferNight(
  facade: WalletFacade,
  keys: AccountKeys,
  state: FacadeState,
  toUnshieldedAddress: string,
  networkId: NetworkId,
  amount: bigint,
): Promise<TransactionIdentifier> {
  const nightTokenType = Object.keys(state.unshielded.balances)[0];
  if (!nightTokenType) {
    throw new Error("funder wallet holds no unshielded NIGHT to transfer");
  }
  const receiverAddress = MidnightBech32m.parse(toUnshieldedAddress).decode(
    UnshieldedAddress,
    networkId,
  );
  const recipe = await balanceWhileDustGenerates(facade, () =>
    facade.transferTransaction(
      [{ type: "unshielded", outputs: [{ type: nightTokenType, receiverAddress, amount }] }],
      { shieldedSecretKeys: keys.shieldedSecretKeys, dustSecretKey: keys.dustSecretKey },
      { ttl: new Date(Date.now() + RECIPE_TTL_MS), payFees: true },
    ),
  );
  const signed = await facade.signRecipe(recipe, keys.unshieldedKeystore.signDataAsync);
  const finalized = await facade.finalizeRecipe(signed);
  return facade.submitTransaction(finalized);
}

/**
 * Register every NIGHT UTXO not yet registered for dust generation, so the
 * wallet can pay transaction fees (fees are paid in DUST, which only
 * generates on registered NIGHT). Registers ONLY unregistered UTXOs — the
 * node rejects a re-registration of an already-registered one — and submits
 * nothing when there is nothing new to register.
 *
 * @param facade - A started wallet facade for `keys` (builds, proves and submits the registration).
 * @param keys - The key material of the same wallet; its unshielded keystore signs the registration.
 * @param state - The synced facade state to read the NIGHT UTXOs from.
 * @returns How many NIGHT UTXOs this call registered (0 = nothing unregistered, including no NIGHT at all).
 * @throws {Error} If the node rejects the registration transaction.
 */
export async function registerNightForDustGeneration(
  facade: WalletFacade,
  keys: AccountKeys,
  state: FacadeState,
): Promise<number> {
  const unregistered = state.unshielded.availableCoins.filter(
    (coin) => !coin.meta.registeredForDustGeneration,
  );
  if (unregistered.length === 0) return 0;

  // Register → finalize (prove) → submit. The registration segments are
  // signed inside registerNightUtxosForDustGeneration via the keystore
  // callback; no separate signRecipe step.
  const recipe = await facade.registerNightUtxosForDustGeneration(
    unregistered,
    keys.unshieldedKeystore.getPublicKey(),
    keys.unshieldedKeystore.signDataAsync,
  );
  const finalized = await facade.finalizeRecipe(recipe);
  await facade.submitTransaction(finalized);
  return unregistered.length;
}

// Dust generates continuously once NIGHT is registered, but a fresh
// registration takes a few blocks before a spendable balance appears.
const DUST_POLL_INTERVAL_MS = 5_000;

/**
 * Wait until the wallet's spendable DUST (fee) balance is positive, polling
 * the synced facade state. Pair with {@link registerNightForDustGeneration}:
 * a wallet whose NIGHT was just registered has no dust for a few blocks.
 *
 * @param facade - A started wallet facade.
 * @param timeoutMs - Give-up deadline in milliseconds.
 * @returns The first positive dust balance observed.
 * @throws {Error} If no dust appears within `timeoutMs`.
 */
export async function waitForSpendableDust(
  facade: WalletFacade,
  timeoutMs = 300_000,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await facade.waitForSyncedState();
    const dust = state.dust.balance(new Date());
    if (dust > 0n) return dust;
    if (Date.now() >= deadline) {
      throw new Error(
        `no spendable DUST after ${String(timeoutMs)} ms — is the wallet's NIGHT registered for dust generation?`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, DUST_POLL_INTERVAL_MS));
  }
}

/**
 * Run `fn` against a started-and-synced {@link WalletFacade}, then stop the
 * facade — even when `fn` throws. The one place the start / wait-for-sync /
 * stop boilerplate lives.
 *
 * @param keys - The account to open the facade for (see {@link deriveAccountKeys}).
 * @param config - The stack the facade connects to.
 * @param fn - Work to run with the live facade; receives the synced state for balance checks.
 * @param options - Optional facade tuning knobs (see {@link WalletFacadeOptions}).
 * @returns Whatever `fn` returns.
 * @throws {Error} Whatever {@link initialiseWalletFacade}, the facade start/sync, or `fn` throws.
 */
export async function withSyncedWalletFacade<T>(
  keys: AccountKeys,
  config: MidnightNodeConfig,
  fn: (facade: WalletFacade, state: FacadeState) => Promise<T>,
  options: WalletFacadeOptions = {},
): Promise<T> {
  const facade = await initialiseWalletFacade(keys, config, options);
  await facade.start(keys.shieldedSecretKeys, keys.dustSecretKey);
  try {
    console.log(`syncing wallet (indexer: ${config.indexerUrl})...`);
    const state = await facade.waitForSyncedState();
    console.log("wallet synced");
    return await fn(facade, state);
  } finally {
    await facade.stop().catch(() => undefined);
  }
}
