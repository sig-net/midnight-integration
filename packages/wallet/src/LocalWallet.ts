import type { UnboundTransaction } from "@midnight-ntwrk/midnight-js/types";
import type {
  CoinPublicKey,
  DustSecretKey,
  EncPublicKey,
  FinalizedTransaction,
  RawTokenType,
  Signature,
  TransactionId,
  UnprovenTransaction,
  ZswapSecretKeys,
} from "@midnightntwrk/ledger-v9";
import { MidnightBech32m, UnshieldedAddress } from "@midnightntwrk/wallet-sdk-address-format";
import type { BalancingRecipe, WalletFacade } from "@midnightntwrk/wallet-sdk-facade";

import { initialiseWalletFacade, RECIPE_TTL_MS, type WalletFacadeOptions } from "./facade.ts";
import { type AccountKeys, deriveAccountKeys, deriveAddresses } from "./keys.ts";
import type { MidnightNodeConfig } from "./midnight-node-config.ts";
import type { NetworkId } from "./network-id.ts";
import { DEFAULT_SYNC_TIMEOUT_MS, type Wallet, type WalletAddresses } from "./Wallet.ts";

// Dust generates continuously once NIGHT is registered, but a fresh
// registration takes a few blocks before a spendable balance appears.
const DUST_POLL_INTERVAL_MS = 5_000;

/**
 * {@link Wallet} backed by an in-process wallet-sdk facade and the key
 * material derived from a seed. Construction is synchronous and OFFLINE:
 * it derives the keys and addresses, so the identity reads
 * ({@link LocalWallet.getAddresses}, {@link LocalWallet.getCoinPublicKey},
 * {@link LocalWallet.getEncryptionPublicKey}) work without any connection.
 * Everything that touches the chain requires {@link LocalWallet.connect}
 * first and throws otherwise — hand a wallet across an API boundary only
 * once it is connected.
 *
 * Lifecycle is the owner's job and lives on this class, not on the
 * {@link Wallet} interface: {@link LocalWallet.connect} /
 * {@link LocalWallet.disconnect} (a disconnected wallet is dead; construct a
 * new one to reconnect), with {@link withLocalWallet} wrapping the whole
 * cycle for scoped work.
 *
 * Beyond the {@link Wallet} contract it carries the funding operations only
 * an in-process wallet can perform ({@link LocalWallet.transferNight},
 * {@link LocalWallet.registerNightForDustGeneration},
 * {@link LocalWallet.waitForSpendableDust}).
 */
export class LocalWallet implements Wallet {
  readonly #keys: AccountKeys;
  readonly #config: MidnightNodeConfig;
  readonly #options: WalletFacadeOptions;
  readonly #addresses: WalletAddresses;
  #facade: WalletFacade | undefined;
  #connection: Promise<void> | undefined;
  #closed = false;
  // Latest sync flag, fed by one state subscription made at connect. Held
  // here so `synced()` never depends on the facade observable's replay
  // semantics: the probe reads this field, nothing else.
  #synced = false;
  #stateSubscription: { unsubscribe(): void } | undefined;

  /**
   * Derive the account's keys and addresses from a seed. Offline — no
   * connection is made until {@link LocalWallet.connect}.
   *
   * @param seed - The wallet seed, as hex or a BIP-39 mnemonic.
   * @param config - The stack the wallet connects to (its network id also
   *   encodes the addresses).
   * @param options - Optional facade tuning knobs (see {@link WalletFacadeOptions}).
   * @throws {Error} If the seed parses to neither hex nor a mnemonic, or key
   *   derivation fails.
   */
  constructor(seed: string, config: MidnightNodeConfig, options: WalletFacadeOptions = {}) {
    this.#keys = deriveAccountKeys(seed, config.networkId);
    this.#config = config;
    this.#options = options;
    this.#addresses = deriveAddresses(this.#keys, config.networkId);
  }

  /**
   * Open the wallet's connection: wire up the facade, start it syncing, and
   * wait for the first synced state. Idempotent — concurrent and repeated
   * calls share one connection attempt.
   *
   * @returns Settled once the wallet is connected and synced.
   * @throws {Error} If the wallet was disconnected, or connecting/syncing fails.
   */
  connect(): Promise<void> {
    if (this.#closed) {
      throw new Error("LocalWallet is disconnected: construct a new one to reconnect.");
    }
    this.#connection ??= this.#open();
    return this.#connection;
  }

  async #open(): Promise<void> {
    const facade = await initialiseWalletFacade(this.#keys, this.#config, this.#options);
    this.#facade = facade;
    await facade.start(this.#keys.shieldedSecretKeys, this.#keys.dustSecretKey);
    this.#stateSubscription = facade.state().subscribe((state) => {
      this.#synced = state.isSynced;
    });
    await facade.waitForSyncedState();
    this.#synced = true;
  }

  /**
   * Close the wallet: stops the facade's node, indexer and prover
   * connections. The wallet is dead afterwards — construct a new one to
   * reconnect. Safe to call on a never-connected wallet.
   *
   * @returns Settled once the facade has stopped.
   */
  async disconnect(): Promise<void> {
    this.#closed = true;
    this.#stateSubscription?.unsubscribe();
    await this.#facade?.stop();
  }

  /**
   * The addresses derived at construction. Available offline.
   *
   * @returns The wallet's addresses.
   */
  getAddresses(): WalletAddresses {
    return this.#addresses;
  }

  /**
   * The network this wallet was constructed for. Available offline.
   *
   * @returns The wallet's network id.
   */
  getNetworkId(): NetworkId {
    return this.#config.networkId;
  }

  /**
   * The latest sync flag from the facade's state stream. Non-blocking.
   *
   * @returns Whether the view is currently synced.
   * @throws {Error} If the wallet is not connected.
   */
  synced(): Promise<boolean> {
    this.#requireFacade();
    return Promise.resolve(this.#synced);
  }

  /**
   * Barrier on the facade's synced state, with a give-up deadline. The
   * re-sync barrier for long-lived wallets: call before handing the wallet
   * out again after a pause, so no consumer incurs the catch-up wait
   * mid-read.
   *
   * @param timeoutMs - Give-up deadline in milliseconds; defaults to
   *   {@link DEFAULT_SYNC_TIMEOUT_MS}.
   * @returns Settled once the state is synced.
   * @throws {Error} If the wallet is not connected, or not synced within `timeoutMs`.
   */
  async waitForSync(timeoutMs: number = DEFAULT_SYNC_TIMEOUT_MS): Promise<void> {
    const facade = this.#requireFacade();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        facade.waitForSyncedState(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`wallet not synced after ${String(timeoutMs)} ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The shielded key pair's coin public key, derived at construction.
   * Available offline.
   *
   * @returns The coin public key, hex-encoded.
   */
  getCoinPublicKey(): CoinPublicKey {
    return this.#keys.shieldedSecretKeys.coinPublicKey;
  }

  /**
   * The shielded key pair's encryption public key, derived at construction.
   * Available offline.
   *
   * @returns The encryption public key, hex-encoded.
   */
  getEncryptionPublicKey(): EncPublicKey {
    return this.#keys.shieldedSecretKeys.encryptionPublicKey;
  }

  /**
   * The synced shielded balances.
   *
   * @returns The balances, empty when the wallet holds no shielded token.
   * @throws {Error} If the wallet is not connected.
   */
  async getShieldedBalances(): Promise<Record<RawTokenType, bigint>> {
    return (await this.#requireFacade().waitForSyncedState()).shielded.balances;
  }

  /**
   * The synced unshielded balances.
   *
   * @returns The balances, empty when the wallet holds no unshielded token.
   * @throws {Error} If the wallet is not connected.
   */
  async getUnshieldedBalances(): Promise<Record<RawTokenType, bigint>> {
    return (await this.#requireFacade().waitForSyncedState()).unshielded.balances;
  }

  /**
   * The synced dust balance, evaluated at the moment of the call.
   *
   * @returns The spendable DUST in base units.
   * @throws {Error} If the wallet is not connected.
   */
  async getDustBalance(): Promise<bigint> {
    return (await this.#requireFacade().waitForSyncedState()).dust.balance(new Date());
  }

  /**
   * Sign with the held unshielded keystore.
   *
   * @param data - The bytes to sign.
   * @returns The signature.
   */
  signData(data: Uint8Array): Promise<Signature> {
    return this.#keys.unshieldedKeystore.signDataAsync(data);
  }

  /**
   * Balance an unbound (proven) transaction via the facade, then sign and
   * prove the balancing additions with the held keys.
   *
   * @param tx - The unbound transaction to balance.
   * @param ttl - Validity deadline of the balancing plan; defaults to
   *   {@link RECIPE_TTL_MS} from now.
   * @returns The finalized, submittable transaction.
   * @throws {Error} If the wallet is not connected, cannot cover fees, or proving fails.
   */
  async balanceTx(tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction> {
    const recipe = await this.#requireFacade().balanceUnboundTransaction(tx, this.#secretKeys(), {
      ttl: ttl ?? new Date(Date.now() + RECIPE_TTL_MS),
    });
    return this.#signAndFinalize(recipe);
  }

  /**
   * Balance an unproven transaction via the facade, then sign and prove
   * with the held keys.
   *
   * @param tx - The unproven transaction to balance.
   * @param ttl - Validity deadline of the balancing plan; defaults to
   *   {@link RECIPE_TTL_MS} from now.
   * @returns The finalized, submittable transaction.
   * @throws {Error} If the wallet is not connected, cannot cover fees, or proving fails.
   */
  async balanceUnprovenTx(tx: UnprovenTransaction, ttl?: Date): Promise<FinalizedTransaction> {
    const recipe = await this.#requireFacade().balanceUnprovenTransaction(tx, this.#secretKeys(), {
      ttl: ttl ?? new Date(Date.now() + RECIPE_TTL_MS),
    });
    return this.#signAndFinalize(recipe);
  }

  /**
   * Submit via the facade's node connection.
   *
   * @param tx - The finalized transaction.
   * @returns The submitted transaction's identifier.
   * @throws {Error} If the wallet is not connected, or the node rejects the transaction.
   */
  submitTx(tx: FinalizedTransaction): Promise<TransactionId> {
    return this.#requireFacade().submitTransaction(tx);
  }

  /**
   * Transfer unshielded NIGHT to another wallet's unshielded (NIGHT
   * receive) address: build the transfer recipe, sign its inputs, prove,
   * and submit. Fees are paid in this wallet's DUST (`payFees`), so it must
   * already be dust-generating. The NIGHT token type is read from the
   * synced state (these chains carry a single unshielded token), so no
   * token constant is hard-coded.
   *
   * @param toUnshieldedAddress - The recipient's unshielded address (bech32m, network-prefixed).
   * @param amount - NIGHT to send, in base units.
   * @returns The submitted transaction's identifier.
   * @throws {Error} If the wallet is not connected, holds no unshielded NIGHT,
   *   or balancing/proving/submission fails.
   */
  async transferNight(toUnshieldedAddress: string, amount: bigint): Promise<TransactionId> {
    const facade = this.#requireFacade();
    const state = await facade.waitForSyncedState();
    const nightTokenType = Object.keys(state.unshielded.balances)[0];
    if (!nightTokenType) {
      throw new Error("wallet holds no unshielded NIGHT to transfer");
    }
    const receiverAddress = MidnightBech32m.parse(toUnshieldedAddress).decode(
      UnshieldedAddress,
      this.#config.networkId,
    );
    const recipe = await facade.transferTransaction(
      [{ type: "unshielded", outputs: [{ type: nightTokenType, receiverAddress, amount }] }],
      this.#secretKeys(),
      { ttl: new Date(Date.now() + RECIPE_TTL_MS), payFees: true },
    );
    const finalized = await this.#signAndFinalize(recipe);
    return facade.submitTransaction(finalized);
  }

  /**
   * Register every NIGHT UTXO not yet registered for dust generation, so
   * the wallet can pay transaction fees (fees are paid in DUST, which only
   * generates on registered NIGHT). Registers ONLY unregistered UTXOs — the
   * node rejects a re-registration of an already-registered one — and
   * submits nothing when there is nothing new to register.
   *
   * @returns How many NIGHT UTXOs this call registered (0 = nothing unregistered, including no NIGHT at all).
   * @throws {Error} If the wallet is not connected, or the node rejects the registration transaction.
   */
  async registerNightForDustGeneration(): Promise<number> {
    const facade = this.#requireFacade();
    const state = await facade.waitForSyncedState();
    const unregistered = state.unshielded.availableCoins.filter(
      (coin) => !coin.meta.registeredForDustGeneration,
    );
    if (unregistered.length === 0) return 0;

    // Register → finalize (prove) → submit. The registration segments are
    // signed inside registerNightUtxosForDustGeneration via the keystore
    // callback; no separate signRecipe step.
    const recipe = await facade.registerNightUtxosForDustGeneration(
      unregistered,
      this.#keys.unshieldedKeystore.getPublicKey(),
      this.#keys.unshieldedKeystore.signDataAsync,
    );
    const finalized = await facade.finalizeRecipe(recipe);
    await facade.submitTransaction(finalized);
    return unregistered.length;
  }

  /**
   * Wait until the wallet's spendable DUST (fee) balance is positive,
   * polling the synced state. Pair with
   * {@link LocalWallet.registerNightForDustGeneration}: a wallet whose
   * NIGHT was just registered has no dust for a few blocks.
   *
   * @param timeoutMs - Give-up deadline in milliseconds.
   * @returns The first positive dust balance observed.
   * @throws {Error} If the wallet is not connected, or no dust appears within `timeoutMs`.
   */
  async waitForSpendableDust(timeoutMs = 300_000): Promise<bigint> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const dust = await this.getDustBalance();
      if (dust > 0n) return dust;
      if (Date.now() >= deadline) {
        throw new Error(
          `no spendable DUST after ${String(timeoutMs)} ms — is the wallet's NIGHT registered for dust generation?`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, DUST_POLL_INTERVAL_MS));
    }
  }

  // The connected facade, or a loud error: chain operations on an
  // unconnected wallet are owner bugs, surfaced at the call site.
  #requireFacade(): WalletFacade {
    if (this.#closed) {
      throw new Error("LocalWallet is disconnected: construct a new one to reconnect.");
    }
    if (!this.#facade) {
      throw new Error("LocalWallet is not connected: call connect() first.");
    }
    return this.#facade;
  }

  // The per-call secret-key argument the facade's balancing methods take.
  #secretKeys(): { shieldedSecretKeys: ZswapSecretKeys; dustSecretKey: DustSecretKey } {
    return {
      shieldedSecretKeys: this.#keys.shieldedSecretKeys,
      dustSecretKey: this.#keys.dustSecretKey,
    };
  }

  // Shared tail of the balance and transfer methods: sign the balancing
  // inputs, then prove into a finalized transaction.
  async #signAndFinalize(recipe: BalancingRecipe): Promise<FinalizedTransaction> {
    const signed = await this.#requireFacade().signRecipe(
      recipe,
      this.#keys.unshieldedKeystore.signDataAsync,
    );
    return this.#requireFacade().finalizeRecipe(signed);
  }
}

/**
 * Run `fn` against a connected {@link LocalWallet}, then disconnect it —
 * even when `fn` throws. The scoped form of the construct / connect /
 * disconnect lifecycle.
 *
 * @param seed - The wallet seed, as hex or a BIP-39 mnemonic.
 * @param config - The stack the wallet connects to.
 * @param fn - Work to run with the connected wallet.
 * @param options - Optional facade tuning knobs (see {@link WalletFacadeOptions}).
 * @returns Whatever `fn` returns.
 * @throws {Error} Whatever construction, {@link LocalWallet.connect}, or `fn` throws.
 */
export async function withLocalWallet<T>(
  seed: string,
  config: MidnightNodeConfig,
  fn: (wallet: LocalWallet) => Promise<T>,
  options: WalletFacadeOptions = {},
): Promise<T> {
  const wallet = new LocalWallet(seed, config, options);
  try {
    await wallet.connect();
    return await fn(wallet);
  } finally {
    await wallet.disconnect().catch(() => undefined);
  }
}
