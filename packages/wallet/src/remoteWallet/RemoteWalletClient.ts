import type { UnboundTransaction } from "@midnight-ntwrk/midnight-js/types";
import type {
  FinalizedTransaction,
  RawTokenType,
  Signature,
  TransactionId,
  UnprovenTransaction,
} from "@midnightntwrk/ledger-v9";

import {
  type BalanceTransactionRequest,
  type MethodCodecs,
  remoteWalletCodecs,
  type RemoteWalletHandshake,
  RemoteWalletMethod,
} from "./protocol.ts";

/**
 * The transport a remote-wallet client speaks through: deliver one
 * method's encoded request to the host and resolve with the encoded
 * response. Reject on failure; the rejection reaches the caller of the
 * wallet method unchanged. How requests travel (HTTP, WebSocket, an
 * in-process loopback) is entirely the transport's business, as is the
 * lifetime of whatever carries them.
 *
 * @param method - The remote-wallet method being invoked.
 * @param request - The method's encoded request payload.
 * @returns The method's encoded response payload.
 */
export type RemoteWalletTransport = (
  method: RemoteWalletMethod,
  request: Uint8Array,
) => Promise<Uint8Array>;

/**
 * Client stub of the remote-wallet protocol: one typed method per
 * {@link RemoteWalletMethod}, each encoding its request with the shared
 * codecs, sending it through the transport, and decoding the response.
 * {@link import("./RemoteWallet.ts").RemoteWallet} wraps this stub into
 * the `Wallet` shape; reach for the stub directly only in a custom
 * integration.
 */
export class RemoteWalletClient {
  readonly #transport: RemoteWalletTransport;

  /**
   * Wrap a transport.
   *
   * @param transport - The transport calls travel through.
   */
  constructor(transport: RemoteWalletTransport) {
    this.#transport = transport;
  }

  /**
   * Fetch the host's handshake: the protocol version it speaks and the
   * hosted wallet's identity.
   *
   * @returns The host's handshake.
   */
  handshake(): Promise<RemoteWalletHandshake> {
    return this.#call(
      RemoteWalletMethod.Handshake,
      remoteWalletCodecs[RemoteWalletMethod.Handshake],
      undefined,
    );
  }

  /**
   * Whether the hosted wallet's chain view is synced right now.
   *
   * @returns Whether the hosted view is currently synced.
   */
  synced(): Promise<boolean> {
    return this.#call(
      RemoteWalletMethod.Synced,
      remoteWalletCodecs[RemoteWalletMethod.Synced],
      undefined,
    );
  }

  /**
   * The hosted wallet's shielded balances.
   *
   * @returns The balances, keyed by raw token type, in base units.
   */
  getShieldedBalances(): Promise<Record<RawTokenType, bigint>> {
    return this.#call(
      RemoteWalletMethod.GetShieldedBalances,
      remoteWalletCodecs[RemoteWalletMethod.GetShieldedBalances],
      undefined,
    );
  }

  /**
   * The hosted wallet's unshielded balances.
   *
   * @returns The balances, keyed by raw token type, in base units.
   */
  getUnshieldedBalances(): Promise<Record<RawTokenType, bigint>> {
    return this.#call(
      RemoteWalletMethod.GetUnshieldedBalances,
      remoteWalletCodecs[RemoteWalletMethod.GetUnshieldedBalances],
      undefined,
    );
  }

  /**
   * The hosted wallet's spendable DUST balance.
   *
   * @returns The spendable DUST in base units.
   */
  getDustBalance(): Promise<bigint> {
    return this.#call(
      RemoteWalletMethod.GetDustBalance,
      remoteWalletCodecs[RemoteWalletMethod.GetDustBalance],
      undefined,
    );
  }

  /**
   * Sign on the host, with the hosted wallet's keys.
   *
   * @param data - The bytes to sign.
   * @returns The signature.
   */
  signData(data: Uint8Array): Promise<Signature> {
    return this.#call(
      RemoteWalletMethod.SignData,
      remoteWalletCodecs[RemoteWalletMethod.SignData],
      data,
    );
  }

  /**
   * Balance an unbound (proven) transaction on the host.
   *
   * @param request - The transaction and optional balancing deadline.
   * @returns The finalized, submittable transaction.
   */
  balanceTx(request: BalanceTransactionRequest<UnboundTransaction>): Promise<FinalizedTransaction> {
    return this.#call(
      RemoteWalletMethod.BalanceTx,
      remoteWalletCodecs[RemoteWalletMethod.BalanceTx],
      request,
    );
  }

  /**
   * Balance an unproven transaction on the host.
   *
   * @param request - The transaction and optional balancing deadline.
   * @returns The finalized, submittable transaction.
   */
  balanceUnprovenTx(
    request: BalanceTransactionRequest<UnprovenTransaction>,
  ): Promise<FinalizedTransaction> {
    return this.#call(
      RemoteWalletMethod.BalanceUnprovenTx,
      remoteWalletCodecs[RemoteWalletMethod.BalanceUnprovenTx],
      request,
    );
  }

  /**
   * Submit on the host, via the hosted wallet's node connection.
   *
   * @param tx - The finalized transaction.
   * @returns The submitted transaction's identifier.
   */
  submitTx(tx: FinalizedTransaction): Promise<TransactionId> {
    return this.#call(
      RemoteWalletMethod.SubmitTx,
      remoteWalletCodecs[RemoteWalletMethod.SubmitTx],
      tx,
    );
  }

  // One round trip: encode with the method's request codec, deliver
  // through the transport, decode with its response codec.
  async #call<Request, Response>(
    method: RemoteWalletMethod,
    codecs: MethodCodecs<Request, Response>,
    request: Request,
  ): Promise<Response> {
    const response = await this.#transport(method, codecs.request.encode(request));
    return codecs.response.decode(response);
  }
}
