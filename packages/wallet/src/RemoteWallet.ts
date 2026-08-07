import type { UnboundTransaction } from "@midnight-ntwrk/midnight-js/types";
import type {
  CoinPublicKey,
  EncPublicKey,
  FinalizedTransaction,
  RawTokenType,
  Signature,
  TransactionId,
  UnprovenTransaction,
} from "@midnightntwrk/ledger-v9";

import type { Wallet, WalletAddresses } from "./Wallet.ts";

/**
 * {@link Wallet} that fulfils each call by talking to a wallet hosted
 * elsewhere (a {@link import("./LocalWallet.ts").LocalWallet} behind a
 * server). The interface types are unchanged: any serialisation happens
 * inside this class, per call, and is invisible to the caller. Lifecycle is
 * the owner's job and lives on this class, not on the {@link Wallet}
 * interface: {@link RemoteWallet.connect} performs the handshake that
 * supplies the synchronous reads (addresses, public keys),
 * {@link RemoteWallet.disconnect} closes the session.
 *
 * Skeleton: neither the handshake nor the wire protocol exists yet, so the
 * synchronous reads throw and every async method rejects.
 */
export class RemoteWallet implements Wallet {
  readonly #hostUrl: URL;

  /**
   * Point at a wallet host.
   *
   * @param hostUrl - Base URL of the hosted wallet's API.
   */
  constructor(hostUrl: URL) {
    this.#hostUrl = hostUrl;
  }

  /**
   * Open the session with the host: the handshake that fetches the
   * wallet's addresses and public keys for the synchronous reads.
   *
   * @returns Settled once the session is established.
   * @throws {Error} Always, until the wire protocol exists.
   */
  connect(): Promise<void> {
    return this.#call("connect");
  }

  /**
   * The hosted wallet's addresses, from the connection handshake.
   *
   * @throws {Error} Always, until the handshake exists.
   */
  getAddresses(): WalletAddresses {
    throw this.#notImplemented("getAddresses");
  }

  /**
   * The hosted wallet's coin public key, from the connection handshake.
   *
   * @throws {Error} Always, until the handshake exists.
   */
  getCoinPublicKey(): CoinPublicKey {
    throw this.#notImplemented("getCoinPublicKey");
  }

  /**
   * The hosted wallet's encryption public key, from the connection
   * handshake.
   *
   * @throws {Error} Always, until the handshake exists.
   */
  getEncryptionPublicKey(): EncPublicKey {
    throw this.#notImplemented("getEncryptionPublicKey");
  }

  /**
   * The hosted wallet's shielded balances.
   *
   * @returns The balances.
   * @throws {Error} Always, until the wire protocol exists.
   */
  getShieldedBalances(): Promise<Record<RawTokenType, bigint>> {
    return this.#call("getShieldedBalances");
  }

  /**
   * The hosted wallet's unshielded balances.
   *
   * @returns The balances.
   * @throws {Error} Always, until the wire protocol exists.
   */
  getUnshieldedBalances(): Promise<Record<RawTokenType, bigint>> {
    return this.#call("getUnshieldedBalances");
  }

  /**
   * The hosted wallet's spendable DUST balance.
   *
   * @returns The spendable DUST in base units.
   * @throws {Error} Always, until the wire protocol exists.
   */
  getDustBalance(): Promise<bigint> {
    return this.#call("getDustBalance");
  }

  /**
   * Sign on the host, with its own keys.
   *
   * @param data - The bytes to sign.
   * @returns The signature.
   * @throws {Error} Always, until the wire protocol exists.
   */
  signData(data: Uint8Array): Promise<Signature> {
    return this.#call("signData", data);
  }

  /**
   * Balance, sign and prove on the host.
   *
   * @param tx - The unbound transaction to balance.
   * @param ttl - Validity deadline of the balancing plan.
   * @returns The finalized, submittable transaction.
   * @throws {Error} Always, until the wire protocol exists.
   */
  balanceTx(tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction> {
    return this.#call(`balanceTx(ttl ${ttl?.toISOString() ?? "default"})`, tx);
  }

  /**
   * Balance, sign and prove an unproven transaction on the host.
   *
   * @param tx - The unproven transaction to balance.
   * @param ttl - Validity deadline of the balancing plan.
   * @returns The finalized, submittable transaction.
   * @throws {Error} Always, until the wire protocol exists.
   */
  balanceUnprovenTx(tx: UnprovenTransaction, ttl?: Date): Promise<FinalizedTransaction> {
    return this.#call(`balanceUnprovenTx(ttl ${ttl?.toISOString() ?? "default"})`, tx);
  }

  /**
   * Submit on the host, via its node connection.
   *
   * @param tx - The finalized transaction.
   * @returns The submitted transaction's identifier.
   * @throws {Error} Always, until the wire protocol exists.
   */
  submitTx(tx: FinalizedTransaction): Promise<TransactionId> {
    return this.#call("submitTx", tx);
  }

  /**
   * Close the session with the host. The wallet is dead afterwards.
   *
   * @returns Settled once the session is closed.
   * @throws {Error} Always, until the wire protocol exists.
   */
  disconnect(): Promise<void> {
    return this.#call("disconnect");
  }

  // The seam the transport plugs into: one place that will encode `payload`,
  // perform the request against the host, and decode the response back into
  // the method's domain type.
  #call(
    request: string,
    payload?: UnboundTransaction | UnprovenTransaction | FinalizedTransaction | Uint8Array,
  ): Promise<never> {
    void payload;
    return Promise.reject(this.#notImplemented(request));
  }

  #notImplemented(request: string): Error {
    return new Error(
      `RemoteWallet: wire protocol not implemented (${request} against ${this.#hostUrl.href})`,
    );
  }
}
