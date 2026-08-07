// A Midnight wallet, end to end: the network/endpoint config to reach a
// stack, seed parsing, and the Wallet interface with its in-process
// (LocalWallet) and hosted (RemoteWallet) implementations. Key derivation
// and the wallet-sdk facade stay INTERNAL: a seed goes in, a wallet comes
// out, and key material never crosses the package boundary.

export * from "./env.ts";
export {
  DEFAULT_ADDITIONAL_FEE_OVERHEAD,
  RECIPE_TTL_MS,
  type WalletFacadeOptions,
} from "./facade.ts";
export * from "./LocalWallet.ts";
export * from "./midnight-node-config.ts";
export * from "./network-id.ts";
export * from "./remoteWallet/index.ts";
export * from "./seed.ts";
export * from "./Wallet.ts";
export type { WalletStateStore } from "./walletStateStore.ts";
