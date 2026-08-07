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

import type { Wallet, WalletAddresses } from "../Wallet.ts";
import { REMOTE_WALLET_PROTOCOL_VERSION, type RemoteWalletHandshake } from "./protocol.ts";
import { RemoteWalletClient, type RemoteWalletTransport } from "./RemoteWalletClient.ts";

/**
 * {@link Wallet} fulfilled by a wallet hosted elsewhere, through a
 * {@link RemoteWalletClient} over the caller-supplied transport. The
 * interface types are unchanged (serialisation happens inside the stubs,
 * invisibly to the caller) and sync stays entirely on the host: this side
 * holds no chain state, no keys, and nothing to sync, only the identity
 * from the handshake.
 *
 * Lifecycle is the owner's job and lives on this class, not on the
 * {@link Wallet} interface: {@link RemoteWallet.connect} performs the
 * handshake (protocol-version check plus the identity that answers the
 * synchronous reads); {@link RemoteWallet.disconnect} makes the wallet
 * dead. The transport's own lifetime (sockets, servers) belongs to
 * whoever created the transport.
 */
export class RemoteWallet implements Wallet {
  readonly #client: RemoteWalletClient;
  #handshake: RemoteWalletHandshake | undefined;
  #connection: Promise<void> | undefined;
  #closed = false;

  /**
   * Wrap a transport. Offline: nothing is sent until
   * {@link RemoteWallet.connect}.
   *
   * @param transport - The transport calls to the host travel through.
   */
  constructor(transport: RemoteWalletTransport) {
    this.#client = new RemoteWalletClient(transport);
  }

  /**
   * Perform the handshake: verify the host speaks this client's protocol
   * version and cache the hosted wallet's identity for the synchronous
   * reads. Idempotent: concurrent and repeated calls share one attempt.
   *
   * @returns Settled once the handshake completes.
   * @throws {Error} If the wallet was disconnected, the host is
   *   unreachable, or the protocol versions differ.
   */
  connect(): Promise<void> {
    if (this.#closed) {
      throw new Error("RemoteWallet is disconnected: construct a new one to reconnect.");
    }
    this.#connection ??= this.#open();
    return this.#connection;
  }

  async #open(): Promise<void> {
    const handshake = await this.#client.handshake();
    if (handshake.protocolVersion !== REMOTE_WALLET_PROTOCOL_VERSION) {
      throw new Error(
        `RemoteWallet: protocol version mismatch: the host speaks ` +
          `${String(handshake.protocolVersion)}, this client speaks ` +
          `${String(REMOTE_WALLET_PROTOCOL_VERSION)}. Align @sig-net/midnight-wallet on both sides.`,
      );
    }
    this.#handshake = handshake;
  }

  /**
   * Make the wallet dead: drop the cached identity and refuse every later
   * call. Nothing is sent to the host, which keeps no per-client session.
   * Safe to call on a never-connected wallet.
   */
  disconnect(): void {
    this.#closed = true;
    this.#handshake = undefined;
  }

  /**
   * The hosted wallet's addresses, from the handshake.
   *
   * @returns The wallet's addresses.
   * @throws {Error} If the wallet is not connected.
   */
  getAddresses(): WalletAddresses {
    return this.#requireHandshake().addresses;
  }

  /**
   * The hosted wallet's coin public key, from the handshake.
   *
   * @returns The coin public key, hex-encoded.
   * @throws {Error} If the wallet is not connected.
   */
  getCoinPublicKey(): CoinPublicKey {
    return this.#requireHandshake().coinPublicKey;
  }

  /**
   * The hosted wallet's encryption public key, from the handshake.
   *
   * @returns The encryption public key, hex-encoded.
   * @throws {Error} If the wallet is not connected.
   */
  getEncryptionPublicKey(): EncPublicKey {
    return this.#requireHandshake().encryptionPublicKey;
  }

  /**
   * The hosted wallet's shielded balances, read from its synced view.
   *
   * @returns The balances, empty when the wallet holds no shielded token.
   * @throws {Error} If the wallet is not connected, or the host call fails.
   */
  async getShieldedBalances(): Promise<Record<RawTokenType, bigint>> {
    this.#requireHandshake();
    return this.#client.getShieldedBalances();
  }

  /**
   * The hosted wallet's unshielded balances, read from its synced view.
   *
   * @returns The balances, empty when the wallet holds no unshielded token.
   * @throws {Error} If the wallet is not connected, or the host call fails.
   */
  async getUnshieldedBalances(): Promise<Record<RawTokenType, bigint>> {
    this.#requireHandshake();
    return this.#client.getUnshieldedBalances();
  }

  /**
   * The hosted wallet's spendable DUST balance, evaluated by the host at
   * the moment of the call.
   *
   * @returns The spendable DUST in base units.
   * @throws {Error} If the wallet is not connected, or the host call fails.
   */
  async getDustBalance(): Promise<bigint> {
    this.#requireHandshake();
    return this.#client.getDustBalance();
  }

  /**
   * Sign on the host, with the hosted wallet's keys.
   *
   * @param data - The bytes to sign.
   * @returns The signature.
   * @throws {Error} If the wallet is not connected, or the host call fails.
   */
  async signData(data: Uint8Array): Promise<Signature> {
    this.#requireHandshake();
    return this.#client.signData(data);
  }

  /**
   * Balance an unbound (proven) transaction on the host: the hosted
   * wallet selects fee inputs from its own synced view, signs and proves.
   *
   * @param tx - The unbound transaction to balance.
   * @param ttl - Validity deadline of the balancing plan; the hosted
   *   wallet applies its default when omitted.
   * @returns The finalized, submittable transaction.
   * @throws {Error} If the wallet is not connected, or the host call fails.
   */
  async balanceTx(tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction> {
    this.#requireHandshake();
    return this.#client.balanceTx(
      ttl === undefined ? { transaction: tx } : { transaction: tx, ttl },
    );
  }

  /**
   * Balance an unproven transaction on the host: the hosted wallet
   * selects fee inputs from its own synced view, signs and proves.
   *
   * @param tx - The unproven transaction to balance.
   * @param ttl - Validity deadline of the balancing plan; the hosted
   *   wallet applies its default when omitted.
   * @returns The finalized, submittable transaction.
   * @throws {Error} If the wallet is not connected, or the host call fails.
   */
  async balanceUnprovenTx(tx: UnprovenTransaction, ttl?: Date): Promise<FinalizedTransaction> {
    this.#requireHandshake();
    return this.#client.balanceUnprovenTx(
      ttl === undefined ? { transaction: tx } : { transaction: tx, ttl },
    );
  }

  /**
   * Submit on the host, via the hosted wallet's node connection.
   *
   * @param tx - The finalized transaction.
   * @returns The submitted transaction's identifier.
   * @throws {Error} If the wallet is not connected, or the host call fails.
   */
  async submitTx(tx: FinalizedTransaction): Promise<TransactionId> {
    this.#requireHandshake();
    return this.#client.submitTx(tx);
  }

  // The handshake identity, or a loud error: calls on an unconnected
  // wallet are owner bugs, surfaced at the call site.
  #requireHandshake(): RemoteWalletHandshake {
    if (this.#closed) {
      throw new Error("RemoteWallet is disconnected: construct a new one to reconnect.");
    }
    if (!this.#handshake) {
      throw new Error("RemoteWallet is not connected: call connect() first.");
    }
    return this.#handshake;
  }
}
