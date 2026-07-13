// PRIVATE copies of @midnight-erc20-vault/lib plumbing: the wallet adapter +
// proof-server provider from midnight-providers.ts, makeVacantCompiledContract
// from deploy.ts, and the AccountKeys / MidnightNodeConfig type shapes.
// Copied — not imported — because this package is PUBLISHED while lib is
// private to the monorepo; the demo packages keep using lib's copies, so KEEP
// THESE IN LOCKSTEP with packages/lib. Only the two types are re-exported
// (via providers.ts); the functions are implementation detail.

import { CompiledContract, type Contract } from "@midnight-ntwrk/compact-js/effect";
import { httpClientProvingProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
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
import type {
  DustSecretKey,
  ProvingKeyMaterial,
  ProvingProvider,
  ZswapSecretKeys,
} from "@midnightntwrk/ledger-v9";
import type { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import type { UnshieldedKeystore } from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import type { Types } from "effect";

/** The live key material for one account. Reused for signing / balancing. */
export interface AccountKeys {
  shieldedSecretKeys: ZswapSecretKeys;
  dustSecretKey: DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
}

/**
 * The set of endpoints (+ network id) needed to reach the chain. Plain data —
 * lib types `networkId` with its richer union; midnight-js itself types a
 * network id as a bare `string`, which is what this published copy uses.
 */
export interface MidnightNodeConfig {
  readonly indexerUrl: string; // indexer GraphQL over HTTP
  readonly indexerWsUrl: string; // indexer GraphQL over WebSocket (subscriptions / sync)
  readonly nodeUrl: string; // Midnight node RPC (HTTP; converted to ws:// for the facade relay)
  readonly proofServerUrl: string; // proof server (ZK proof generation)
  readonly networkId: string; // which network these endpoints belong to
}

// Balancing recipes expire 30 min out (same TTL as lib's submitUnprovenTransaction).
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
 * while the ledger-v9 1.0.0-rc.3 WASM this package resolves validates that
 * `lookupKey` is also present. Delete in favor of `httpClientProofProvider`
 * once midnight-js ships a beta aligned with ledger-v9 1.0.0-rc.3.
 *
 * @param proofServerUrl - The proof server's HTTP endpoint.
 * @param zkConfigProvider - Provider of the contract's compiled ZK artifacts (prover/verifier keys + ZKIR).
 * @returns The proof provider to place in a contract's midnight-js provider set.
 */
export function createProofServerProvider<K extends string>(
  proofServerUrl: string,
  zkConfigProvider: ZKConfigProvider<K>,
): ProofProvider {
  const registry = new ZKConfigRegistry([zkConfigProvider as ZKConfigProvider<string>]);

  // Pass the REGISTRY (not the provider) to the base: its /check and /prove
  // key resolution special-cases a ZKConfigRegistry. The `as` bridges the
  // nominal type: the base only ever calls `.resolveKeyLocation` on it.
  const base = httpClientProvingProvider(
    proofServerUrl,
    registry as unknown as ZKConfigProvider<string>,
  );

  // Same resolution order as midnight-js's internal key-material resolver:
  // canonical contract key locations through the registry's verifier-key
  // join; otherwise the location as a bare circuit name against the flat
  // provider; protocol builtins ("midnight/...") resolve to undefined and
  // are supplied by the proof server itself.
  const lookupKey = async (keyLocation: string): Promise<ProvingKeyMaterial | undefined> => {
    const resolved = await registry.resolveKeyLocation(keyLocation);
    if (resolved !== undefined) {
      return zkConfigToProvingKeyMaterial(resolved);
    }
    try {
      return zkConfigToProvingKeyMaterial(await zkConfigProvider.get(keyLocation as K));
    } catch {
      return undefined;
    }
  };

  const provingProvider: ProvingProvider = { ...base, lookupKey };
  return createProofProvider(provingProvider);
}

/**
 * Bind a generated Compact contract that declares NO witnesses to its
 * compiled assets. compact-js types `Contract.Witnesses<C>` as `never` when
 * the generated witness shape is empty, so witness-less contracts must bind
 * via `withVacantWitnesses` rather than passing an empty object.
 *
 * @param tag - Identifier for the binding (not the on-chain address), e.g. the contract name.
 * @param ctor - The `Contract` class exported by the generated `managed/contract` module.
 * @param managedDirPath - Absolute path to the compiler output dir (`contract/`, `zkir/`, `keys/`, `compiler/`).
 * @returns The fully-bound {@link CompiledContract.CompiledContract}, ready for deploy/join tooling.
 */
export function makeVacantCompiledContract<C extends Contract.Contract<PS>, PS>(
  tag: string,
  ctor: Types.Ctor<C>,
  managedDirPath: string,
): CompiledContract.CompiledContract<C, PS> {
  const base = CompiledContract.make<C, PS>(tag, ctor);
  const vacant = CompiledContract.withVacantWitnesses(base);
  return CompiledContract.withCompiledFileAssets(vacant, managedDirPath);
}
