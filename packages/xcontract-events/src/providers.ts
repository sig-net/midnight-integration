// midnight-js provider sets + compiled-contract bindings for the two spike
// contracts. Modeled on signet-contract/src/providers.ts (both contracts are
// witness-less).
//
// The one cross-contract-specific bit: the VAULT's proof provider must resolve
// proving/verifier keys for BOTH contracts, because a call to
// `depositViaVault` produces a transaction whose call tree also contains the
// token's `deposit` — each call carries its own proof. So we build it with
// lib's `createCrossContractProofServerProvider([vaultZk, tokenZk])` rather
// than the single-contract `createProofServerProvider`.

import { fileURLToPath } from "node:url";

import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import type { MidnightProviders } from "@midnight-ntwrk/midnight-js/types";
import type { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";

import {
  createCrossContractProofServerProvider,
  createWalletAndMidnightProvider,
  makeVacantCompiledContract,
  type AccountKeys,
  type MidnightNodeConfig,
} from "@midnight-erc20-vault/lib";

import { Contract as TokenContract } from "./managed/Token/contract/index.js";
import { Contract as VaultContract } from "./managed/vault/contract/index.js";
import {
  tokenWitnesses,
  vaultWitnesses,
  type TokenPrivateState,
  type VaultPrivateState,
} from "./witnesses.ts";

/** Provable circuit ids, straight from each generated contract. */
export type TokenCircuitId = keyof InstanceType<typeof TokenContract>["provableCircuits"] & string;
export type VaultCircuitId = keyof InstanceType<typeof VaultContract>["provableCircuits"] & string;

/** Private-state store keys (single-value unions, one per contract). */
export type TokenPrivateStateId = "xc-token";
export type VaultPrivateStateId = "xc-vault";
export const TOKEN_PRIVATE_STATE_ID: TokenPrivateStateId = "xc-token";
export const VAULT_PRIVATE_STATE_ID: VaultPrivateStateId = "xc-vault";

export type VaultProviders = MidnightProviders<VaultCircuitId, VaultPrivateStateId, VaultPrivateState>;

// Compiler output dirs (contract/, keys/, zkir/) — the zk-config roots.
const tokenManagedPath = fileURLToPath(new URL("./managed/Token", import.meta.url));
const vaultManagedPath = fileURLToPath(new URL("./managed/vault", import.meta.url));

/** Compiled-contract bindings (witness-less → vacant witnesses). */
export const tokenCompiledContract = makeVacantCompiledContract<TokenContract<TokenPrivateState>, TokenPrivateState>(
  "xc-token",
  TokenContract,
  tokenManagedPath,
);
export const vaultCompiledContract = makeVacantCompiledContract<VaultContract<VaultPrivateState>, VaultPrivateState>(
  "xc-vault",
  VaultContract,
  vaultManagedPath,
);

// Bind the witness objects so the found-contract handle's callTx carries real
// (empty) witnesses. makeVacantCompiledContract already binds vacant witnesses;
// referencing these keeps the imports meaningful and documents intent.
void tokenWitnesses;
void vaultWitnesses;

/**
 * Build the midnight-js provider set for the VAULT, wired for cross-contract
 * calls: its proof provider resolves keys across both the vault and the token
 * so `callTx.depositViaVault(...)` can prove the whole call tree.
 *
 * @param facade - A started (and synced) wallet facade.
 * @param keys - The key material of the same wallet, for balancing and signing.
 * @param config - The Midnight network endpoints to run against.
 * @returns The provider set to hand to `findDeployedContract`.
 */
export function buildVaultProviders(
  facade: WalletFacade,
  keys: AccountKeys,
  config: MidnightNodeConfig,
): VaultProviders {
  const vaultZkConfigProvider = new NodeZkConfigProvider<VaultCircuitId>(vaultManagedPath);
  const tokenZkConfigProvider = new NodeZkConfigProvider<TokenCircuitId>(tokenManagedPath);

  const walletAndMidnightProvider = createWalletAndMidnightProvider(facade, keys);
  const accountId = walletAndMidnightProvider.getCoinPublicKey();

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: "xc-vault-private-states",
      signingKeyStoreName: "xc-vault-signing-keys",
      accountId,
      privateStoragePasswordProvider: () => "&*(BHJqwe419-xcontractEvents",
    }),

    publicDataProvider: indexerPublicDataProvider({
      queryURL: config.indexerUrl,
      subscriptionURL: config.indexerWsUrl,
    }),

    // The vault's own circuits resolve here; the cross-contract proof
    // provider (below) resolves the token's.
    zkConfigProvider: vaultZkConfigProvider,

    // Spans BOTH contracts — the crux of proving a cross-contract call.
    proofProvider: createCrossContractProofServerProvider(config.proofServerUrl, [
      vaultZkConfigProvider,
      tokenZkConfigProvider,
    ]),

    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };
}
