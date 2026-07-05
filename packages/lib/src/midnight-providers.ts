// Adapts the WalletFacade-based account to midnight-js's wallet interfaces,
// so midnight-js (`findDeployedContract` → `contract.callTx.<circuit>(...)`)
// can balance, prove and submit contract-call transactions through the same
// wallet this package builds. compact-js binds contracts and runs circuits
// locally but does NOT assemble + prove + submit a ledger call transaction —
// midnight-js is the orchestration layer for that. Ported from midday
// `app/playground/lib/providers.ts`; the contract-specific provider set
// (indexer / proof server / zk-config / private-state store) lives with each
// contract package, since it depends on that package's compiled assets.

import type {
  MidnightProvider,
  UnboundTransaction,
  WalletProvider,
} from "@midnight-ntwrk/midnight-js/types";
import type { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";

import type { AccountKeys } from "./wallet.ts";

// Balancing recipes expire 30 min out (same TTL as submitUnprovenTransaction).
const BALANCE_TTL_MS = 30 * 60 * 1000;

/**
 * Adapt a started {@link WalletFacade} + {@link AccountKeys} to midnight-js's
 * `WalletProvider & MidnightProvider`. `balanceTx` balances the unbound
 * transaction with the account's shielded/dust keys, signs, then finalizes
 * (which proves); `submitTx` relays through the facade.
 *
 * The midnight-js ledger types come from `midnight-js-protocol`; the facade
 * uses `ledger-v8`. They are the same underlying classes, so the values pass
 * straight through — the casts only bridge the two packages' nominal type
 * identities.
 *
 * @param facade - A started (and synced) wallet facade.
 * @param keys - The key material of the same wallet, for balancing and signing.
 * @returns The provider pair midnight-js uses as balancer + submitter.
 */
export function createWalletAndMidnightProvider(
  facade: WalletFacade,
  keys: AccountKeys,
): WalletProvider & MidnightProvider {
  return {
    getCoinPublicKey: () => keys.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => keys.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: UnboundTransaction, ttl?: Date) {
      const recipe = await facade.balanceUnboundTransaction(
        tx as never,
        { shieldedSecretKeys: keys.shieldedSecretKeys, dustSecretKey: keys.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + BALANCE_TTL_MS) },
      );
      const signed = await facade.signRecipe(recipe, (payload) => keys.unshieldedKeystore.signData(payload));
      return (await facade.finalizeRecipe(signed)) as never;
    },
    submitTx: (tx) => facade.submitTransaction(tx as never) as never,
  };
}
