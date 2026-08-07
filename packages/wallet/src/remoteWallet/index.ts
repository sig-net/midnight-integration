// The remote-wallet protocol: RemoteWallet (the Wallet-shaped client),
// the transport-agnostic client and server stubs it is built from, and
// the wire contract they share. An external host implements the server
// side by wrapping a ready Wallet in RemoteWalletServer and binding its
// handle method to a transport; the codecs stay internal to the stubs.

export {
  type BalanceTransactionRequest,
  REMOTE_WALLET_PROTOCOL_VERSION,
  type RemoteWalletHandshake,
  RemoteWalletMethod,
} from "./protocol.ts";
export { RemoteWallet } from "./RemoteWallet.ts";
export { RemoteWalletClient, type RemoteWalletTransport } from "./RemoteWalletClient.ts";
export { RemoteWalletServer } from "./RemoteWalletServer.ts";
