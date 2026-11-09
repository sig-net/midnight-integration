// Adapts the WalletFacade-based account to midnight-js's wallet interfaces,
// so midnight-js (`findDeployedContract` → `contract.callTx.<circuit>(...)`)
// can balance, prove and submit contract-call transactions through the same
// wallet this package builds. compact-js binds contracts and runs circuits
// locally but does NOT assemble + prove + submit a ledger call transaction —
// midnight-js is the orchestration layer for that. Ported from midday
// `app/playground/lib/providers.ts`; the contract-specific provider set
// (indexer / proof server / zk-config / private-state store) lives with each
// contract package, since it depends on that package's compiled assets.

import {
  createLedger9MidnightProvider,
  createLedger9WalletProvider,
  type MidnightProvider,
  type ProofProvider,
  type WalletProvider,
  type ZKConfigProvider,
  ZKConfigRegistry,
} from "@midnight-ntwrk/midnight-js/types";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import type { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { type AccountKeys, TRANSACTION_TTL_MS } from "@sig-net/midnight-contract-deploy";

/** The wallet halves of a midnight-js provider set, both backed by one facade. */
export interface FacadeWalletProviders {
  /** Balances, signs and proves midnight-js's unbound transactions. */
  readonly walletProvider: WalletProvider;
  /** Submits midnight-js's finalized transactions. */
  readonly midnightProvider: MidnightProvider;
}

/**
 * Adapt a started {@link WalletFacade} + {@link AccountKeys} to midnight-js's
 * ledger-9 `WalletProvider` and `MidnightProvider`. Transactions cross between
 * the two SDKs as bytes: midnight-js and the facade each seal them in their
 * own handle type.
 *
 * @param facade - A started (and synced) wallet facade.
 * @param keys - The key material of the same wallet, whose keystore signs the balancing inputs.
 * @returns The balancer and submitter midnight-js uses.
 */
export function createFacadeWalletProviders(
  facade: WalletFacade,
  keys: AccountKeys,
): FacadeWalletProviders {
  const walletProvider = createLedger9WalletProvider({
    getCoinPublicKey: () => keys.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => keys.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx, ttl) {
      const recipe = await facade.balanceUnboundTransaction(
        facade.adoptTransaction(tx.serialize(), "Unbound"),
        { ttl: ttl ?? new Date(Date.now() + TRANSACTION_TTL_MS) },
      );
      const signed = await facade.signRecipe(recipe, keys.unshieldedKeystore.signDataAsync);
      return facade.finalizeRecipe(signed);
    },
  });
  const midnightProvider = createLedger9MidnightProvider((tx) =>
    facade.submitTransaction(facade.adoptTransaction(tx.serialize(), "Finalized")),
  );
  return { walletProvider, midnightProvider };
}

/**
 * Build the {@link ProofProvider} for a contract's provider set: proving via
 * the proof server, with keys resolved across a *set* of compiled-contract
 * sources, which a **cross-contract call** needs: one transaction whose call
 * tree spans several deployed contracts, each carrying its own proof. A
 * single-contract call is the one-element case.
 *
 * The `ZKConfigRegistry` joins each call's canonical key location
 * (`contract:<addr>/<circuitId>?vk=<sha-256 of the deployed verifier key>`) to
 * the source whose local verifier key matches, immune to redeploys and to
 * circuit-name collisions across contracts.
 *
 * @param proofServerUrl - The proof server's HTTP endpoint.
 * @param zkConfigProviders - One provider per compiled contract the call can reach (the caller plus every callee).
 * @returns The proof provider to place in a contract's midnight-js provider set.
 * @throws {Error} If `zkConfigProviders` is empty.
 */
export function createCrossContractProofServerProvider(
  proofServerUrl: string,
  zkConfigProviders: readonly ZKConfigProvider<string>[],
): ProofProvider {
  if (zkConfigProviders.length === 0) {
    throw new Error(
      "createCrossContractProofServerProvider: at least one zkConfigProvider is required",
    );
  }
  return httpClientProofProvider({
    url: proofServerUrl,
    zkConfigProvider: new ZKConfigRegistry([...zkConfigProviders]),
  });
}
