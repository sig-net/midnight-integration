import type { Wallet } from "../Wallet.ts";
import {
  REMOTE_WALLET_PROTOCOL_VERSION,
  remoteWalletCodecs,
  RemoteWalletMethod,
} from "./protocol.ts";

const REMOTE_WALLET_METHODS: readonly RemoteWalletMethod[] = Object.values(RemoteWalletMethod);

function isRemoteWalletMethod(value: string): value is RemoteWalletMethod {
  return (REMOTE_WALLET_METHODS as readonly string[]).includes(value);
}

/**
 * Server stub of the remote-wallet protocol: routes each encoded request
 * to a backing {@link Wallet} and encodes the result, through the same
 * shared codecs the client stub uses. Transport-agnostic: a host binds
 * {@link RemoteWalletServer.handle} to whatever carries its requests (an
 * HTTP route, a WebSocket message handler, an in-process loopback).
 *
 * The backing wallet must be READY, per the {@link Wallet} contract: for a
 * `LocalWallet` that means connected before serving. Hosting lifecycle
 * (starting the transport, connecting and disconnecting the backing
 * wallet) belongs to the host, not to this stub, and the protocol keeps
 * the server stateless per request: its only state is the one long-lived
 * wallet.
 */
export class RemoteWalletServer {
  readonly #wallet: Wallet;

  /**
   * Bind a ready wallet.
   *
   * @param wallet - The ready wallet requests are served from.
   */
  constructor(wallet: Wallet) {
    this.#wallet = wallet;
  }

  /**
   * Serve one request: decode it, invoke the backing wallet, encode the
   * result. Rejections (unknown method, malformed payload, or whatever
   * the backing wallet throws) are the transport's to convey back to the
   * client.
   *
   * @param method - The method name from the wire (untrusted).
   * @param request - The method's encoded request payload (untrusted).
   * @returns The method's encoded response payload.
   * @throws {Error} If the method is unknown, the payload is malformed,
   *   or the backing wallet fails.
   */
  async handle(method: string, request: Uint8Array): Promise<Uint8Array> {
    if (!isRemoteWalletMethod(method)) {
      throw new Error(`RemoteWalletServer: unknown method "${method}"`);
    }
    switch (method) {
      case RemoteWalletMethod.Handshake: {
        const { response } = remoteWalletCodecs[RemoteWalletMethod.Handshake];
        return response.encode({
          protocolVersion: REMOTE_WALLET_PROTOCOL_VERSION,
          addresses: this.#wallet.getAddresses(),
          coinPublicKey: this.#wallet.getCoinPublicKey(),
          encryptionPublicKey: this.#wallet.getEncryptionPublicKey(),
        });
      }
      case RemoteWalletMethod.GetShieldedBalances: {
        const { response } = remoteWalletCodecs[RemoteWalletMethod.GetShieldedBalances];
        return response.encode(await this.#wallet.getShieldedBalances());
      }
      case RemoteWalletMethod.GetUnshieldedBalances: {
        const { response } = remoteWalletCodecs[RemoteWalletMethod.GetUnshieldedBalances];
        return response.encode(await this.#wallet.getUnshieldedBalances());
      }
      case RemoteWalletMethod.GetDustBalance: {
        const { response } = remoteWalletCodecs[RemoteWalletMethod.GetDustBalance];
        return response.encode(await this.#wallet.getDustBalance());
      }
      case RemoteWalletMethod.SignData: {
        const { request: requestCodec, response } = remoteWalletCodecs[RemoteWalletMethod.SignData];
        return response.encode(await this.#wallet.signData(requestCodec.decode(request)));
      }
      case RemoteWalletMethod.BalanceTx: {
        const { request: requestCodec, response } =
          remoteWalletCodecs[RemoteWalletMethod.BalanceTx];
        const { transaction, ttl } = requestCodec.decode(request);
        return response.encode(await this.#wallet.balanceTx(transaction, ttl));
      }
      case RemoteWalletMethod.BalanceUnprovenTx: {
        const { request: requestCodec, response } =
          remoteWalletCodecs[RemoteWalletMethod.BalanceUnprovenTx];
        const { transaction, ttl } = requestCodec.decode(request);
        return response.encode(await this.#wallet.balanceUnprovenTx(transaction, ttl));
      }
      case RemoteWalletMethod.SubmitTx: {
        const { request: requestCodec, response } = remoteWalletCodecs[RemoteWalletMethod.SubmitTx];
        return response.encode(await this.#wallet.submitTx(requestCodec.decode(request)));
      }
    }
  }
}
