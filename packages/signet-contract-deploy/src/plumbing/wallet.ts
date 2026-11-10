// Seed → account construction utilities: key derivation, address encoding,
// WalletFacade wiring, and the facade-driven steps (sync, balance, submit,
// NIGHT transfer, dust registration) the deploy flow is built from.
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
import { type DefaultDustConfiguration, DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import type { SyncService } from "@midnightntwrk/wallet-sdk-dust-wallet/v1";
import {
  type FacadeState,
  mergeWalletEntries,
  type TransactionIdentifier,
  WalletEntrySchema,
  WalletFacade,
} from "@midnightntwrk/wallet-sdk-facade";
import { WalletSeeds } from "@midnightntwrk/wallet-sdk-hd";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import {
  createKeystore,
  PublicKey as UnshieldedPublicKey,
  type UnshieldedKeystore,
  UnshieldedWallet,
} from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import { redactUrlQuery } from "@sig-net/midnight";
import { Cause, Option, Runtime } from "effect";

import { formatDust } from "./format-amounts.ts";
import type { MidnightNodeConfig } from "./midnight-node-config.ts";
import { isLocalStandaloneNetwork, type NetworkId } from "./network-id.ts";
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

/** The live key material for one account. Reused for starting the facade and signing. */
export interface AccountKeys {
  /** The per-wallet seeds the facade starts from, as sensitive as the secret keys derived from them below. */
  seeds: WalletSeeds;
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

/** How long the transactions this package builds stay valid, in milliseconds. */
export const TRANSACTION_TTL_MS = 30 * 60 * 1000;

// The facade balances every submitted transaction with
// `feesWithMargin(params, FEE_BLOCKS_MARGIN) + additionalFeeOverhead`, so the
// overhead is burned as dust on EVERY transaction. It compensates for the
// wallet sdk pricing a PROOF-ERASED transaction while the node prices the
// real proof bytes: the node's fee exceeds the wallet's estimate by an amount
// that grows with proof size, and the node rejects the spend with
// Malformed(BalanceCheckOverspend) when the wallet under-provides. The local
// standalone chain's dust is free, so its overhead covers the gap this
// repo's circuits produce with headroom. A deployed network's dust is scarce
// (faucet-funded NIGHT generates it slowly), so its overhead is zero: raise
// it for a network whose node rejects a spend with
// Malformed(BalanceCheckOverspend).
const UNDEPLOYED_ADDITIONAL_FEE_OVERHEAD = 50_000_000_000_000n;
const DEPLOYED_ADDITIONAL_FEE_OVERHEAD = 0n;

// Fee margin in blocks the facade balances with, alongside the overhead.
const FEE_BLOCKS_MARGIN = 5;

/**
 * The `additionalFeeOverhead` a facade balances with when its
 * {@link WalletFacadeOptions} name none: 5e13 on the local standalone chain,
 * whose dust is free, and 0 on every deployed network, whose dust is scarce.
 *
 * @param networkId - The network the facade connects to.
 * @returns The overhead burned as dust on top of every transaction's estimated fee.
 */
export function defaultAdditionalFeeOverhead(networkId: NetworkId): bigint {
  return isLocalStandaloneNetwork(networkId)
    ? UNDEPLOYED_ADDITIONAL_FEE_OVERHEAD
    : DEPLOYED_ADDITIONAL_FEE_OVERHEAD;
}

/**
 * Optional tuning knobs for {@link initialiseWalletFacade} (and
 * {@link withSyncedWalletFacade} and {@link WalletRegistry}, which pass them
 * through).
 */
export interface WalletFacadeOptions {
  /**
   * Flat fee overhead added on top of the estimated fee of every submitted
   * transaction, burned as dust each time. Defaults to
   * {@link defaultAdditionalFeeOverhead} for the facade's network.
   */
  additionalFeeOverhead?: bigint;
  /**
   * Whether the DUST wallet starts at the chain's Ledger 9 fork, leaving the
   * Ledger 8 DUST events unread and absent from its transaction history.
   * Defaults to true; pass false for a wallet that must replay DUST from
   * genesis.
   */
  skipLedgerV8DustHistory?: boolean;
}

/** The DUST a facade refusal reports holding and needing, in base units. */
export interface DustShortfall {
  /** The DUST the facade found available to the refused call. */
  readonly have: bigint;
  /** The DUST the refused call needs. */
  readonly need: bigint;
}

// A facade refusal that names its shortfall does so as "(have X, need Y)":
// the dust-registration refusal ("Insufficient generated dust to cover
// registration fee (have X, need Y)") does, the balancing refusals (see
// isInsufficientDust) name no amount.
const DUST_SHORTFALL = /dust\b.*?\(have (\d+), need (\d+)\)/i;

/**
 * The amounts a facade refusal names when it refuses for lack of DUST.
 *
 * @param error - What a facade call threw.
 * @returns The named shortfall, or undefined for a refusal that names no
 *   amount and for any other error.
 */
export function dustShortfall(error: unknown): DustShortfall | undefined {
  const match = DUST_SHORTFALL.exec(String(error));
  const have = match?.[1];
  const need = match?.[2];
  return have === undefined || need === undefined
    ? undefined
    : { have: BigInt(have), need: BigInt(need) };
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
  const seeds = WalletSeeds.fromMasterSeed(seedBytes);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(seeds.shielded);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(seeds.dust);
  const unshieldedKeystore = createKeystore(
    { kind: "schnorr", secret: seeds.unshielded },
    networkId,
  );

  return { seeds, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
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
 * Indexer events the shielded and DUST wallets apply per batch: per-batch
 * overhead dominates a sync at the SDK's default of 10.
 */
const SYNC_BATCH_SIZE = 1000;

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
        additionalFeeOverhead:
          options.additionalFeeOverhead ?? defaultAdditionalFeeOverhead(config.networkId),
        feeBlocksMargin: FEE_BLOCKS_MARGIN,
      },
      txHistoryStorage: new InMemoryTransactionHistoryStorage(
        WalletEntrySchema,
        mergeWalletEntries,
      ),
    },
    shielded: (cfg) =>
      ShieldedWallet({ ...cfg, batchUpdates: { size: SYNC_BATCH_SIZE } }).startWithSeed(
        keys.seeds.shielded,
      ),
    unshielded: (cfg) =>
      UnshieldedWallet(cfg).startWithPublicKey(
        UnshieldedPublicKey.fromKeyStore(keys.unshieldedKeystore),
      ),
    dust: (cfg) => {
      // DustWallet's declared configuration omits the sync fields its default sync reads.
      const dustConfiguration: DefaultDustConfiguration & SyncService.DefaultSyncConfiguration = {
        ...cfg,
        batchUpdates: { size: SYNC_BATCH_SIZE },
        skipLedgerV8DustHistory: options.skipLedgerV8DustHistory ?? true,
      };
      return DustWallet(dustConfiguration).startWithSeed(
        keys.seeds.dust,
        ledger.LedgerParameters.initialParameters().dust,
      );
    },
  });
}

// Dust generates continuously once NIGHT is registered, but a fresh
// registration takes a few blocks before a spendable balance appears.
const DUST_POLL_INTERVAL_MS = 5_000;

/**
 * Wait until the wallet's spendable DUST (fee) balance reaches `minimumDust`,
 * polling the synced facade state and logging each reading. Pair with
 * {@link registerNightForDustGeneration}: a wallet whose NIGHT was just
 * registered has no dust for a few blocks.
 *
 * @param facade - A started wallet facade.
 * @param minimumDust - The spendable DUST to wait for, in base units (1 = any dust at all).
 * @param timeoutMs - Give-up deadline in milliseconds.
 * @returns The first spendable dust balance at or above `minimumDust`.
 * @throws {Error} If the balance stays below `minimumDust` for `timeoutMs`.
 */
export async function waitForSpendableDust(
  facade: WalletFacade,
  minimumDust: bigint,
  timeoutMs = 300_000,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await facade.waitForSyncedState();
    const dust = state.dust.balance(new Date());
    if (dust >= minimumDust) return dust;
    if (Date.now() >= deadline) {
      throw new Error(
        `spendable DUST reached ${formatDust(dust)} of the ${formatDust(minimumDust)} needed after ${String(timeoutMs)} ms: ` +
          "is the wallet's NIGHT registered for dust generation, and is there enough of it to generate the fees?",
      );
    }
    console.log(
      `spendable DUST ${formatDust(dust)} of the ${formatDust(minimumDust)} needed, waiting...`,
    );
    await new Promise((resolve) => setTimeout(resolve, DUST_POLL_INTERVAL_MS));
  }
}

const BALANCE_RETRY_INTERVAL_MS = 15_000;
const BALANCE_RETRY_TIMEOUT_MS = 6 * 60 * 1000;

// The dust wallet's balancing runs through `Effect.runPromise`, which rejects
// with a fiber wrapper holding the typed failure in its cause.
function walletFailure(error: unknown): unknown {
  if (!Runtime.isFiberFailure(error)) return error;
  return Option.getOrElse(
    Cause.failureOption(error[Runtime.FiberFailureCauseId]),
    (): unknown => error,
  );
}

/**
 * Whether a facade refusal is the dust wallet's `Wallet.InsufficientFunds`
 * failure for the `dust` token: the wallet's DUST cannot cover the fee, which
 * on a fresh registration means it has not generated enough yet.
 *
 * @param error - What a facade call rejected with.
 * @returns Whether the rejection is an insufficient-DUST balancing refusal.
 */
export function isInsufficientDust(error: unknown): boolean {
  const failure = walletFailure(error);
  return (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    failure._tag === "Wallet.InsufficientFunds" &&
    "tokenType" in failure &&
    failure.tokenType === "dust"
  );
}

/**
 * Run a recipe-building call, retrying while it fails for lack of DUST
 * within {@link BALANCE_RETRY_TIMEOUT_MS}. A refusal naming its shortfall
 * (see {@link dustShortfall}) waits for the spendable DUST to reach the
 * named amount before building again. One naming no amount is rebuilt each
 * interval, after the facade reports itself synced again so the balancer
 * works from the chain tip.
 *
 * @param facade - The started facade `build` balances with.
 * @param build - The balancing call to (re)attempt.
 * @returns The recipe `build` resolves to.
 * @throws {Error} Immediately for any error other than insufficient dust, the
 *   facade's own error once the retry budget is spent, or the wait's error
 *   when a named shortfall does not generate within the budget.
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
      const insufficientDust = isInsufficientDust(error) || dustShortfall(error) !== undefined;
      if (!insufficientDust || Date.now() >= deadline) throw error;
      console.warn("DUST fee balancing failed, retrying:", error);
      const shortfall = dustShortfall(error);
      if (shortfall === undefined) {
        console.log(
          `the wallet cannot cover the fee yet (DUST still generating), retrying in ${String(BALANCE_RETRY_INTERVAL_MS / 1000)}s`,
        );
        await new Promise((resolve) => setTimeout(resolve, BALANCE_RETRY_INTERVAL_MS));
        const state = await facade.waitForSyncedState();
        console.log(
          `wallet resynced, spendable DUST: ${formatDust(state.dust.balance(new Date()))}`,
        );
        continue;
      }
      console.log(
        `the wallet holds ${formatDust(shortfall.have)} of the ${formatDust(shortfall.need)} DUST the fee needs, waiting for the rest to generate`,
      );
      await waitForSpendableDust(facade, shortfall.need, deadline - Date.now());
    }
  }
}

/**
 * The fee the facade prices a serialized unproven transaction at: the
 * ledger's fee with the facade's block margin plus the network's overhead
 * (see {@link defaultAdditionalFeeOverhead}). The balancing inputs the
 * facade adds at submission carry a further small fee, so this is the floor
 * of what submitting the transaction burns.
 *
 * @param facade - A started facade, whose network sets the overhead.
 * @param serializedTransaction - The unproven transaction bytes.
 * @returns The transaction's fee in DUST base units.
 */
export async function estimateUnprovenTransactionFee(
  facade: WalletFacade,
  serializedTransaction: Uint8Array,
): Promise<bigint> {
  return facade.calculateTransactionFee(facade.adoptTransaction(serializedTransaction, "Unproven"));
}

/**
 * Balance, sign, prove and submit a serialized unproven transaction (e.g. a
 * contract deploy built by `buildDeployTransaction` in deploy.ts). Proving
 * happens in `finalizeRecipe` via the facade's configured proof server.
 *
 * @param facade - A started (and synced) wallet facade that pays for and submits the transaction.
 * @param keys - The key material of the same wallet, for signing the balancing inputs.
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
  const tx = facade.adoptTransaction(serializedTransaction, "Unproven");

  // Balance (add dust/fee inputs) → sign those inputs → finalize (prove) → submit.
  console.log("balancing and signing transaction...");
  const recipe = await balanceWhileDustGenerates(facade, () =>
    facade.balanceUnprovenTransaction(tx, { ttl: new Date(Date.now() + TRANSACTION_TTL_MS) }),
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
 * inputs, prove, and submit. Fees are paid in the sender's DUST (balanced in
 * a separate dust-only step; the transfer itself is built with
 * `payFees: false`), so the sender must already be dust-generating. The NIGHT token type is read
 * from the sender's synced state (these chains carry a single unshielded
 * token), so no token constant is hard-coded.
 *
 * @param facade - A started, synced, dust-generating wallet facade (the funder).
 * @param keys - The funder's key material, for signing the balancing inputs.
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
  const ttl = new Date(Date.now() + TRANSACTION_TTL_MS);
  // Keep the reserved NIGHT inputs in one transfer throughout fee retries.
  const transfer = await facade.transferTransaction(
    [{ type: "unshielded", outputs: [{ type: nightTokenType, receiverAddress, amount }] }],
    { ttl, payFees: false },
  );
  const recipe = await balanceWhileDustGenerates(facade, () =>
    facade.balanceUnprovenTransaction(transfer.transaction, {
      ttl,
      tokenKindsToBalance: ["dust"],
    }),
  ).catch(async (error: unknown) => {
    await facade.revert(transfer).catch((revertError: unknown) => {
      console.error("Failed to release NIGHT transfer inputs:", revertError);
    });
    throw error;
  });
  const signed = await facade.signRecipe(recipe, keys.unshieldedKeystore.signDataAsync);
  const finalized = await facade.finalizeRecipe(signed);
  return facade.submitTransaction(finalized);
}

// How long a fresh NIGHT UTXO may take to generate its own registration fee.
const GENERATED_DUST_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Register every NIGHT UTXO not yet registered for dust generation, so the
 * wallet can pay transaction fees (fees are paid in DUST, which only
 * generates on registered NIGHT). Registers ONLY unregistered UTXOs — the
 * node rejects a re-registration of an already-registered one — and submits
 * nothing when there is nothing new to register. A first-time registration
 * pays its own fee out of the dust its NIGHT UTXOs have generated since they
 * landed, and a UTXO that landed moments ago has not yet generated it: the
 * facade refuses naming the shortfall (see {@link dustShortfall}), and this
 * waits for exactly that amount to generate before registering again.
 *
 * @param facade - A started wallet facade for `keys` (builds, proves and submits the registration).
 * @param keys - The key material of the same wallet; its unshielded keystore signs the registration.
 * @param state - The synced facade state to read the NIGHT UTXOs from.
 * @returns How many NIGHT UTXOs this call registered (0 = nothing unregistered, including no NIGHT at all).
 * @throws {Error} If the fee does not generate within {@link GENERATED_DUST_TIMEOUT_MS}, or
 *   the node rejects the registration transaction.
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
  const register = () =>
    facade.registerNightUtxosForDustGeneration(
      unregistered,
      keys.unshieldedKeystore.getPublicKey(),
      keys.unshieldedKeystore.signDataAsync,
    );
  let recipe: Awaited<ReturnType<typeof register>>;
  try {
    recipe = await register();
  } catch (error) {
    const shortfall = dustShortfall(error);
    if (shortfall === undefined) throw error;
    console.log(
      `the NIGHT has generated ${formatDust(shortfall.have)} of the ${formatDust(shortfall.need)} DUST its registration costs, waiting...`,
    );
    await facade.waitForGeneratedDust(unregistered, shortfall.need, {
      timeoutMs: GENERATED_DUST_TIMEOUT_MS,
    });
    recipe = await register();
  }
  const finalized = await facade.finalizeRecipe(recipe);
  await facade.submitTransaction(finalized);
  return unregistered.length;
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
  await facade.start(keys.seeds);
  try {
    const state = await waitForSyncedStateLogging(facade, "wallet", config);
    return await fn(facade, state);
  } finally {
    await facade.stop().catch(() => undefined);
  }
}

// How often a sync in progress reports itself.
const SYNC_HEARTBEAT_MS = 10_000;

/**
 * One sub-wallet's sync position as "applied/highest", the two indices every
 * sub-wallet's progress record carries under its own field names.
 *
 * @param applied - The index the sub-wallet has applied up to.
 * @param highest - The highest index the indexer reports.
 * @returns The position, with a percentage once the highest index is known.
 */
function syncPosition(applied: bigint, highest: bigint): string {
  if (highest <= 0n) return `${String(applied)}/?`;
  return `${String(applied)}/${String(highest)} (${String((applied * 100n) / highest)}%)`;
}

/** The unshielded sync facts {@link unshieldedSyncPosition} reports on. */
export type UnshieldedSyncProgress = Pick<
  FacadeState["unshielded"]["progress"],
  "appliedId" | "highestTransactionId" | "isConnected" | "indexerLiveness"
>;

/**
 * The unshielded wallet's sync position for the heartbeat. It follows one
 * address's transactions, so its head arrives with the indexer's first
 * progress frame for that address, and it reports synced only once the
 * indexer's height also agrees with the node's finalized head.
 *
 * @param progress - The unshielded wallet's progress record.
 * @returns What the wallet has applied, or what it is waiting for.
 */
export function unshieldedSyncPosition(progress: UnshieldedSyncProgress): string {
  if (!progress.isConnected) return "waiting for the indexer's first progress frame";
  const position =
    progress.highestTransactionId <= 0n
      ? "no transactions for this address"
      : syncPosition(progress.appliedId, progress.highestTransactionId);
  const liveness = progress.indexerLiveness;
  switch (liveness._tag) {
    case "Unknown":
      return `${position}, node head check pending`;
    case "Unavailable":
      return `${position}, node head check failed ${String(liveness.consecutiveFailures)} time(s)`;
    case "Behind":
      return `${position}, indexer ${String(liveness.lag)} block(s) behind the node`;
    case "WrongNetwork":
      return `${position}, indexer and node disagree on block ${String(liveness.height)}`;
    case "Skipped":
    case "InSync":
    case "Ahead":
      return position;
  }
}

/**
 * Wait for a started facade to report itself synced, logging a heartbeat
 * every {@link SYNC_HEARTBEAT_MS} with the elapsed time and each sub-wallet's
 * position, so a long first sync on a deployed network shows it is moving.
 *
 * @param facade - The started facade to wait on.
 * @param label - The wallet's name in the log lines (its role, e.g. `root`).
 * @param config - The stack the facade syncs against, named in the first line.
 * @returns The synced state.
 */
async function waitForSyncedStateLogging(
  facade: WalletFacade,
  label: string,
  config: MidnightNodeConfig,
): Promise<FacadeState> {
  const started = Date.now();
  const elapsed = (): string => `${String(Math.round((Date.now() - started) / 1000))}s`;
  console.log(`syncing ${label} wallet (indexer: ${redactUrlQuery(config.indexerUrl)})...`);
  let latest: FacadeState | undefined;
  const subscription = facade.state().subscribe({
    next: (state) => {
      latest = state;
    },
  });
  const heartbeat = setInterval(() => {
    const position =
      latest === undefined
        ? "no state yet"
        : `shielded ${syncPosition(latest.shielded.progress.appliedIndex, latest.shielded.progress.highestRelevantWalletIndex)}, ` +
          `dust ${syncPosition(latest.dust.progress.appliedIndex, latest.dust.progress.highestRelevantWalletIndex)}, ` +
          `unshielded ${unshieldedSyncPosition(latest.unshielded.progress)}`;
    console.log(`  ${label} wallet still syncing after ${elapsed()}: ${position}`);
  }, SYNC_HEARTBEAT_MS);
  try {
    const state = await facade.waitForSyncedState();
    console.log(`${label} wallet synced in ${elapsed()}`);
    return state;
  } finally {
    clearInterval(heartbeat);
    subscription.unsubscribe();
  }
}

/** A wallet a {@link WalletRegistry} holds started and synced. */
export interface RegisteredWallet {
  /** The wallet's role name, as logged. */
  readonly label: string;
  /** The wallet's key material, for starting the facade and signing. */
  readonly keys: AccountKeys;
  /** The started facade. Later `waitForSyncedState()` calls catch it up incrementally. */
  readonly facade: WalletFacade;
}

/**
 * The dedup key a {@link WalletRegistry} files a seed under: its normalised
 * hex, so two spellings of one seed (0x-prefixed, upper case, a mnemonic and
 * its derived hex) share a facade.
 *
 * @param seed - The wallet seed, as hex or a BIP-39 mnemonic.
 * @returns The seed's normalised hex.
 * @throws {ParseError} If the seed parses as neither form.
 */
export function walletRegistryKey(seed: string): string {
  return parseSeed(seed).source.seedHex;
}

/**
 * One started, synced facade per wallet for the life of a pipeline: the
 * first request for a seed builds, starts and fully syncs its facade (the
 * expensive step on a deployed network, where a fresh facade scans the chain
 * from nothing), every later request returns the same running facade, whose
 * `waitForSyncedState()` only catches up incrementally. {@link close} stops
 * every facade once, at the end.
 */
export class WalletRegistry {
  private readonly wallets = new Map<string, Promise<RegisteredWallet>>();

  /**
   * @param config - The stack every facade in the registry connects to.
   * @param options - Facade tuning passed to every facade built here.
   */
  constructor(
    readonly config: MidnightNodeConfig,
    private readonly options: WalletFacadeOptions = {},
  ) {}

  /**
   * The started, synced wallet for `seed`, built on first request.
   *
   * @param seed - The wallet seed, as hex or a BIP-39 mnemonic.
   * @param label - The wallet's role name, used in the sync log lines.
   * @returns The registered wallet.
   * @throws {Error} Whatever building, starting or syncing the facade throws. The
   *   failed entry is dropped, so a later request retries.
   */
  wallet(seed: string, label: string): Promise<RegisteredWallet> {
    const key = walletRegistryKey(seed);
    const existing = this.wallets.get(key);
    if (existing !== undefined) return existing;
    const opened = this.open(seed, label).catch((error: unknown) => {
      this.wallets.delete(key);
      throw error;
    });
    this.wallets.set(key, opened);
    return opened;
  }

  private async open(seed: string, label: string): Promise<RegisteredWallet> {
    const keys = deriveAccountKeys(seed, this.config.networkId);
    const facade = await initialiseWalletFacade(keys, this.config, this.options);
    await facade.start(keys.seeds);
    try {
      await waitForSyncedStateLogging(facade, label, this.config);
    } catch (error) {
      await facade.stop().catch(() => undefined);
      throw error;
    }
    return { label, keys, facade };
  }

  /**
   * Stop every facade the registry opened. Safe to call more than once and
   * with nothing opened.
   */
  async close(): Promise<void> {
    const opened = [...this.wallets.values()];
    this.wallets.clear();
    await Promise.all(
      opened.map(async (pending) => {
        const wallet = await pending.catch(() => undefined);
        await wallet?.facade.stop().catch(() => undefined);
      }),
    );
  }
}
