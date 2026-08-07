// The wallet interface the @sig-net/midnight* packages run against, shaped
// like the wallet a Midnight dapp holds. It extends the two midnight-js
// provider roles a wallet fills for the contract SDK (WalletProvider
// balances, signs and proves; MidnightProvider submits), so one instance
// plugs into a MidnightProviders set directly as its `walletProvider` and
// `midnightProvider`. On top of those roles: address and balance reads, raw
// data signing, and the unproven-transaction counterpart of `balanceTx`
// that a contract deploy needs (a deploy transaction starts unproven, while
// `balanceTx` starts from an already-proven call transcript).

import type { MidnightProvider, WalletProvider } from "@midnight-ntwrk/midnight-js/types";
import type {
  FinalizedTransaction,
  RawTokenType,
  Signature,
  UnprovenTransaction,
} from "@midnightntwrk/ledger-v9";

// The identifier type `submitTx` resolves to, and the encryption-key string
// type of `getEncryptionPublicKey` — re-exported so wallet consumers can
// name them without adding the ledger package themselves.
export type { EncPublicKey, TransactionId } from "@midnightntwrk/ledger-v9";

/** A wallet's three Midnight addresses, as bech32m strings. */
export interface WalletAddresses {
  unshielded: string; // NIGHT receive address
  shielded: string;
  dust: string;
}

/**
 * A Midnight wallet: identity (addresses, public keys), balance reads, raw
 * data signing, and the transaction pipeline the contract SDK's provider
 * roles define. `balanceTx`, `getCoinPublicKey`, `getEncryptionPublicKey`
 * and `submitTx` are inherited from {@link WalletProvider} and
 * {@link MidnightProvider} and documented there.
 *
 * A `Wallet` received across an API boundary is READY: connected, synced,
 * and every method valid. Lifecycle (connecting, disconnecting) is the
 * owner's job and lives on the concrete implementation, so a borrower can
 * never end a session it does not own.
 *
 * Implementations: {@link import("./LocalWallet.ts").LocalWallet}
 * (in-process, over the wallet-sdk facade) and
 * {@link import("./remoteWallet/RemoteWallet.ts").RemoteWallet} (a hosted wallet, same
 * contract).
 */
export interface Wallet extends WalletProvider, MidnightProvider {
  /**
   * The wallet's three Midnight addresses (unshielded, shielded, dust) as
   * bech32m strings. Fixed for the wallet's lifetime, so available
   * synchronously.
   *
   * @returns The wallet's addresses.
   */
  getAddresses(): WalletAddresses;

  /**
   * The wallet's shielded token balances, keyed by raw token type, in base
   * units. Resolves once the wallet is synced.
   *
   * @returns The balances, empty when the wallet holds no shielded token.
   */
  getShieldedBalances(): Promise<Record<RawTokenType, bigint>>;

  /**
   * The wallet's unshielded token balances (NIGHT among them), keyed by raw
   * token type, in base units. Resolves once the wallet is synced.
   *
   * @returns The balances, empty when the wallet holds no unshielded token.
   */
  getUnshieldedBalances(): Promise<Record<RawTokenType, bigint>>;

  /**
   * The wallet's spendable DUST (fee) balance, evaluated at the moment of
   * the call (dust accrues continuously on registered NIGHT, so the balance
   * moves between two reads). Resolves once the wallet is synced.
   *
   * @returns The spendable DUST in base units.
   */
  getDustBalance(): Promise<bigint>;

  /**
   * Sign raw bytes with the wallet's unshielded key.
   *
   * @param data - The bytes to sign.
   * @returns The signature.
   */
  signData(data: Uint8Array): Promise<Signature>;

  /**
   * Counterpart of the inherited `balanceTx` for a transaction that is not
   * yet proven (a contract deploy): balance it with fee inputs, sign those
   * inputs, and prove the result. Pair with the inherited `submitTx`.
   *
   * @param tx - The unproven transaction to balance.
   * @param ttl - Validity deadline of the balancing plan; the wallet
   *   applies its default when omitted.
   * @returns The finalized, submittable transaction.
   * @throws {Error} If the wallet cannot cover fees or proving fails.
   */
  balanceUnprovenTx(tx: UnprovenTransaction, ttl?: Date): Promise<FinalizedTransaction>;
}
