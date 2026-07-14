// Seed → account construction utilities shared by every wallet host (the UI's
// SeedWallet and the integration tests' buildWallet): key derivation, address
// encoding and WalletFacade wiring. Pure crypto + facade construction — no
// network I/O happens here (the facade connects only when started).
import * as ledger from "@midnightntwrk/ledger-v9";
import { HDWallet, Roles } from "@midnightntwrk/wallet-sdk-hd";
import {
  mergeWalletEntries,
  WalletEntrySchema,
  WalletFacade,
  type FacadeState,
  type TransactionIdentifier,
} from "@midnightntwrk/wallet-sdk-facade";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import {
  createKeystore,
  PublicKey as UnshieldedPublicKey,
  type UnshieldedKeystore,
  UnshieldedWallet,
} from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import { InMemoryTransactionHistoryStorage } from "@midnightntwrk/wallet-sdk-abstractions";
import {
  DustAddress,
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from "@midnightntwrk/wallet-sdk-address-format";

import type { MidnightNodeConfig } from "./midnight-node-config.ts";
import type { NetworkId } from "./network-id.ts";
import { parseSeed } from "./seed.ts";

// Consumers hold facades/states we hand them without adding the wallet-sdk
// packages themselves — re-export the handle types alongside the builders.
export type { FacadeState, TransactionIdentifier, WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
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
 * The fee settings the facade balances transactions with: it burns
 * `feesWithMargin(params, feeBlocksMargin) + additionalFeeOverhead` per
 * transaction.
 */
export const COST_PARAMETERS: { readonly additionalFeeOverhead: bigint; readonly feeBlocksMargin: number } = {
  additionalFeeOverhead: 300_000_000_000n,
  feeBlocksMargin: 5,
};

/**
 * Parse a seed and derive the three role keys (Zswap / NightExternal / Dust).
 * Pure crypto — no network. This is the step that exercises the ledger WASM.
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

/** Compute the three bech32m addresses from the keys. Pure — no network. */
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
 */
export function initialiseWalletFacade(keys: AccountKeys, config: MidnightNodeConfig): Promise<WalletFacade> {
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
      costParameters: COST_PARAMETERS,
      txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    },
    shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(keys.shieldedSecretKeys),
    unshielded: (cfg) =>
      UnshieldedWallet(cfg).startWithPublicKey(UnshieldedPublicKey.fromKeyStore(keys.unshieldedKeystore)),
    dust: (cfg) =>
      DustWallet(cfg).startWithSecretKey(keys.dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
}

// Recipes (balancing plans for submitted transactions) expire 30 min out.
const RECIPE_TTL_MS = 30 * 60 * 1000;

/**
 * Balance, sign, prove and submit a serialized unproven transaction (e.g. a
 * contract deploy built by `buildDeployTransaction` in deploy.ts). Proving
 * happens in `finalizeRecipe` via the facade's configured proof server.
 *
 * @param facade - A started (and synced) wallet facade that pays for and submits the transaction.
 * @param keys - The key material of the same wallet, for balancing and signing.
 * @param serializedTransaction - The unproven transaction bytes.
 * @returns The submitted transaction's identifier.
 * @throws If the wallet cannot cover fees, proving fails, or the node rejects the transaction.
 */
export async function submitUnprovenTransaction(
  facade: WalletFacade,
  keys: AccountKeys,
  serializedTransaction: Uint8Array,
): Promise<TransactionIdentifier> {
  // Deserialize back into the ledger UnprovenTransaction the facade balances.
  const tx = ledger.Transaction.deserialize<ledger.SignatureEnabled, ledger.PreProof, ledger.PreBinding>(
    "signature",
    "pre-proof",
    "pre-binding",
    serializedTransaction,
  );

  // Balance (add dust/fee inputs) → sign those inputs → finalize (prove) → submit.
  const recipe = await facade.balanceUnprovenTransaction(
    tx,
    { shieldedSecretKeys: keys.shieldedSecretKeys, dustSecretKey: keys.dustSecretKey },
    { ttl: new Date(Date.now() + RECIPE_TTL_MS) },
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
 * @returns How many NIGHT UTXOs this call registered (0 = all were already registered).
 * @throws If the wallet holds no NIGHT at all, or the node rejects the registration transaction.
 */
export async function registerNightForDustGeneration(
  facade: WalletFacade,
  keys: AccountKeys,
  state: FacadeState,
): Promise<number> {
  const nightUtxos = state.unshielded.availableCoins;
  if (nightUtxos.length === 0) {
    throw new Error(
      "wallet holds no NIGHT UTXOs — fund it with NIGHT before registering for dust generation.",
    );
  }
  const unregistered = nightUtxos.filter((coin) => !coin.meta.registeredForDustGeneration);
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
 * @throws If no dust appears within `timeoutMs`.
 */
export async function waitForSpendableDust(facade: WalletFacade, timeoutMs: number = 300_000): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await facade.waitForSyncedState();
    const dust = state.dust.balance(new Date());
    if (dust > 0n) return dust;
    if (Date.now() >= deadline) {
      throw new Error(
        `no spendable DUST after ${timeoutMs} ms — is the wallet's NIGHT registered for dust generation?`,
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
 * @returns Whatever `fn` returns.
 * @throws Whatever {@link initialiseWalletFacade}, the facade start/sync, or `fn` throws.
 */
export async function withSyncedWalletFacade<T>(
  keys: AccountKeys,
  config: MidnightNodeConfig,
  fn: (facade: WalletFacade, state: FacadeState) => Promise<T>,
): Promise<T> {
  const facade = await initialiseWalletFacade(keys, config);
  await facade.start(keys.shieldedSecretKeys, keys.dustSecretKey);
  try {
    const state = await facade.waitForSyncedState();
    return await fn(facade, state);
  } finally {
    await facade.stop().catch(() => {});
  }
}
