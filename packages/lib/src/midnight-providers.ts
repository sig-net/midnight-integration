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
  createProofProvider,
  ZKConfigRegistry,
  zkConfigToProvingKeyMaterial,
  type MidnightProvider,
  type ProofProvider,
  type UnboundTransaction,
  type WalletProvider,
  type ZKConfigProvider,
} from "@midnight-ntwrk/midnight-js/types";
import { httpClientProvingProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import type { ProvingKeyMaterial, ProvingProvider } from "@midnightntwrk/ledger-v9";
import type { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";

import type { AccountKeys } from "@sig-net/midnight-contract-deploy";

// Balancing recipes expire 30 min out (same TTL as submitUnprovenTransaction).
const BALANCE_TTL_MS = 30 * 60 * 1000;

/**
 * Adapt a started {@link WalletFacade} + {@link AccountKeys} to midnight-js's
 * `WalletProvider & MidnightProvider`. `balanceTx` balances the unbound
 * transaction with the account's shielded/dust keys, signs, then finalizes
 * (which proves); `submitTx` relays through the facade.
 *
 * The midnight-js ledger types come from `midnight-js-protocol`; the facade
 * uses `ledger-v9`. They are the same underlying classes, so the values pass
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
      const signed = await facade.signRecipe(recipe, keys.unshieldedKeystore.signDataAsync);
      return (await facade.finalizeRecipe(signed)) as never;
    },
    submitTx: (tx) => facade.submitTransaction(tx as never) as never,
  };
}

/**
 * Build the {@link ProofProvider} for a contract's provider set: proving via
 * the proof server's /check + /prove endpoints, with ZK key material resolved
 * from the contract's compiled assets through `zkConfigProvider`.
 *
 * Exists instead of midnight-js's own `httpClientProofProvider` because that
 * one (5.0.0-beta.3) builds a circuit-level `ProvingProvider` with only
 * `check`/`prove` — the ledger-v9 1.0.0-rc.2 shape it was released against —
 * while the ledger-v9 1.0.0-rc.3 WASM this workspace resolves (the version
 * the wallet-sdk betas pin) validates that `lookupKey` is also present and
 * throws "expected proving provider property 'lookupKey' to be a function"
 * on every circuit-call proof. This wrapper reuses midnight-js's proving
 * provider and grafts on a `lookupKey` backed by the same key-material
 * resolution its `check`/`prove` use. Delete in favor of
 * `httpClientProofProvider` once midnight-js ships a beta aligned with
 * ledger-v9 1.0.0-rc.3.
 *
 * @param proofServerUrl - The proof server's HTTP endpoint.
 * @param zkConfigProvider - Provider of the contract's compiled ZK artifacts (prover/verifier keys + ZKIR).
 * @returns The proof provider to place in a contract's midnight-js provider set.
 */
export function createProofServerProvider<K extends string>(
  proofServerUrl: string,
  zkConfigProvider: ZKConfigProvider<K>,
): ProofProvider {
  return createCrossContractProofServerProvider(proofServerUrl, [zkConfigProvider]);
}

/**
 * Like {@link createProofServerProvider}, but resolves proving/verifier keys
 * across a *set* of compiled-contract sources — what a **cross-contract call**
 * needs: one transaction whose call tree spans several deployed contracts, each
 * carrying its own proof, so proving must find artifacts for every contract in
 * the tree (the root and each callee).
 *
 * The `ZKConfigRegistry` joins each call's canonical key location
 * (`contract:<addr>/<circuitId>?vk=<sha-256 of the deployed verifier key>`) to
 * the source whose local verifier key matches — immune to redeploys and to
 * circuit-name collisions across contracts. Pass one `ZKConfigProvider` per
 * compiled contract the call can reach (the caller plus every callee).
 *
 * @param proofServerUrl - The proof server's HTTP endpoint.
 * @param zkConfigProviders - One provider per compiled contract in the call tree; must be non-empty.
 * @returns The proof provider to place in a contract's midnight-js provider set.
 * @throws If `zkConfigProviders` is empty.
 */
export function createCrossContractProofServerProvider(
  proofServerUrl: string,
  zkConfigProviders: readonly ZKConfigProvider<string>[],
): ProofProvider {
  if (zkConfigProviders.length === 0) {
    throw new Error("createCrossContractProofServerProvider: at least one zkConfigProvider is required");
  }

  const registry = new ZKConfigRegistry([...zkConfigProviders]);

  // Pass the REGISTRY (not a single provider) to the base: its /check and
  // /prove key resolution (`makeKeyMaterialResolver`) special-cases a
  // ZKConfigRegistry and resolves every contract in the call tree through it.
  // Passing one provider would leave /check unable to find a *callee* circuit's
  // key (its verifier-key join has only the caller), which fails a
  // cross-contract call at the check step. The `as` bridges the nominal type:
  // the base only ever calls `.resolveKeyLocation` on a registry argument.
  const base = httpClientProvingProvider(
    proofServerUrl,
    registry as unknown as ZKConfigProvider<string>,
  );

  // Same resolution order as midnight-js's internal key-material resolver:
  // canonical contract key locations through the registry's verifier-key
  // join; otherwise try the location as a bare circuit name against each flat
  // provider in turn; protocol builtins ("midnight/...") resolve to undefined
  // and are supplied by the proof server itself.
  const lookupKey = async (
    keyLocation: string,
  ): Promise<ProvingKeyMaterial | undefined> => {
    const resolved = await registry.resolveKeyLocation(keyLocation);
    if (resolved !== undefined) {
      return zkConfigToProvingKeyMaterial(resolved);
    }
    for (const provider of zkConfigProviders) {
      try {
        return zkConfigToProvingKeyMaterial(await provider.get(keyLocation));
      } catch {
        // try the next provider
      }
    }
    return undefined;
  };

  const provingProvider: ProvingProvider = { ...base, lookupKey };
  return createProofProvider(provingProvider);
}
