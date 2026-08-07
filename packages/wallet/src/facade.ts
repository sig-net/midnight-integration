// WalletFacade wiring: constructs the three sub-wallets from an account's
// keys and a stack's endpoints. Construction only — no network I/O happens
// here (the facade connects when started).
import * as ledger from "@midnightntwrk/ledger-v9";
import { InMemoryTransactionHistoryStorage } from "@midnightntwrk/wallet-sdk-abstractions";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import {
  mergeWalletEntries,
  WalletEntrySchema,
  WalletFacade,
} from "@midnightntwrk/wallet-sdk-facade";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import {
  PublicKey as UnshieldedPublicKey,
  UnshieldedWallet,
} from "@midnightntwrk/wallet-sdk-unshielded-wallet";

import type { AccountKeys } from "./keys.ts";
import type { MidnightNodeConfig } from "./midnight-node-config.ts";

/**
 * Default `additionalFeeOverhead` the facade balances transactions with: it
 * burns `feesWithMargin(params, feeBlocksMargin) + additionalFeeOverhead`
 * per transaction, so the overhead is burned as dust on EVERY submitted
 * transaction.
 *
 * The overhead compensates for the wallet sdk pricing a PROOF-ERASED
 * transaction while the node prices the real proof bytes. Keccak-based
 * verification proofs (~9.2 KB, vs ~6.4 KB for persistentHash-era ones)
 * left the node's fee ~2.2e13 above the wallet's estimate, so the node
 * rejected the spend with Malformed(BalanceCheckOverspend). 5e13 covers
 * that with headroom, and the excess is simply burned dust. The default is
 * tuned for local fakenet chains where dust is free: real-network deploys
 * may want a lower value (see {@link WalletFacadeOptions}).
 */
export const DEFAULT_ADDITIONAL_FEE_OVERHEAD = 50_000_000_000_000n;

// Fee margin in blocks the facade balances with, alongside the overhead.
const FEE_BLOCKS_MARGIN = 5;

/** How long a recipe (the balancing plan of a transaction) stays valid before it must be rebuilt. */
export const RECIPE_TTL_MS = 30 * 60 * 1000;

/**
 * Optional tuning knobs for {@link initialiseWalletFacade} (and the helpers
 * that pass them through, e.g. `withLocalWallet` in LocalWallet.ts).
 */
export interface WalletFacadeOptions {
  /**
   * Flat fee overhead added on top of the estimated fee of every submitted
   * transaction, burned as dust each time. Defaults to
   * {@link DEFAULT_ADDITIONAL_FEE_OVERHEAD} (5e13), which is tuned for local
   * fakenet chains: real-network deploys may want it lower.
   */
  additionalFeeOverhead?: bigint;
}

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
        additionalFeeOverhead: options.additionalFeeOverhead ?? DEFAULT_ADDITIONAL_FEE_OVERHEAD,
        feeBlocksMargin: FEE_BLOCKS_MARGIN,
      },
      txHistoryStorage: new InMemoryTransactionHistoryStorage(
        WalletEntrySchema,
        mergeWalletEntries,
      ),
    },
    shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(keys.shieldedSecretKeys),
    unshielded: (cfg) =>
      UnshieldedWallet(cfg).startWithPublicKey(
        UnshieldedPublicKey.fromKeyStore(keys.unshieldedKeystore),
      ),
    dust: (cfg) =>
      DustWallet(cfg).startWithSecretKey(
        keys.dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
      ),
  });
}
