// The vault's midnight-js provider set — everything VAULT-specific about
// talking to a deployed instance: the compiled-contract binding (generated
// module + witnesses + this package's managed assets), the zk-config path the
// proof provider reads keys from, the circuit-id union, and the private-state
// store id. The generic wallet + adapter come from @midnight-erc20-vault/lib;
// clients compose the two and call `findDeployedContract(providers, ...)`.

import { fileURLToPath } from "node:url";

import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import type { MidnightProviders } from "@midnight-ntwrk/midnight-js/types";
import type { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";

import {
  createCrossContractProofServerProvider,
  createWalletAndMidnightProvider,
  makeCompiledContract,
  type AccountKeys,
  type MidnightNodeConfig,
} from "@midnight-erc20-vault/lib";

import { Contract } from "./managed/erc20-vault/contract/index.js";
import { witnesses, type VaultPrivateState } from "./witnesses.ts";

/** The vault's provable circuit ids, straight from the generated contract. */
export type VaultCircuitId = keyof InstanceType<typeof Contract>["provableCircuits"] & string;

/**
 * Literal of the private-state storage key. Just a string, but a
 * single-value union so the providers/`findDeployedContract` pairing is
 * enforced by the type system.
 */
export type VaultPrivateStateId = "erc20-vault";

/**
 * Key under which midnight-js persists the vault's private state locally (in
 * the private-state store from {@link buildVaultProviders}). Distinct per
 * contract so two clients don't share an entry.
 */
export const VAULT_PRIVATE_STATE_ID: VaultPrivateStateId = "erc20-vault";

/** The full midnight-js provider set, typed to the vault. */
export type VaultProviders = MidnightProviders<
  // PCK: the union of the contract's provable circuit names.
  VaultCircuitId,
  // PSI: the private-state storage key literal.
  VaultPrivateStateId,
  // PS: the shape of the contract's private state object.
  VaultPrivateState
>;

// The compiler output dirs (each holds contract/, keys/, zkir/) — the "zk
// config roots" the proof + zk-config providers read proving/verifier keys
// from. deposit cross-contract-calls the signet contract, so proving
// spans both: signetManagedPath is a compile-time symlink to the deployed
// signet contract's managed output (see this package's compile script).
const managedPath = fileURLToPath(new URL("./managed/erc20-vault", import.meta.url));
const signetManagedPath = fileURLToPath(new URL("./managed/SignetEventEmitter", import.meta.url));

/**
 * The vault's compact-js compiled-contract binding: generated module + real
 * witnesses + this package's compiled assets. Consumed by
 * `findDeployedContract` (and usable by deploy tooling).
 */
export const vaultCompiledContract = makeCompiledContract<Contract<VaultPrivateState>, VaultPrivateState>(
  "erc20-vault",
  Contract,
  witnesses,
  managedPath,
);

/**
 * Build the midnight-js provider set for the vault.
 *
 * @param facade - A started (and synced) wallet facade — see lib's `withSyncedWalletFacade`.
 * @param keys - The key material of the same wallet, for balancing and signing.
 * @param config - The Midnight network endpoints to run against.
 * @returns The provider set to hand to `findDeployedContract` / `deployContract`.
 */
export function buildVaultProviders(
  facade: WalletFacade,
  keys: AccountKeys,
  config: MidnightNodeConfig,
): VaultProviders {
  // Retrieves the ZK artifacts of a contract needed to create proofs.
  // Key methods: getProverKey(id), getVerifierKey(id), getZKIR(id) — id is
  // typed to the circuit-name union.
  const zkConfigProvider = new NodeZkConfigProvider<VaultCircuitId>(managedPath);

  // The callee (signet contract) circuits, resolved for the cross-contract
  // proof provider so deposit's whole call tree proves.
  const signetZkConfigProvider = new NodeZkConfigProvider<string>(signetManagedPath);

  // The wallet, adapted to midnight-js's balancer + submitter interfaces
  // (the facade itself does not implement WalletProvider/MidnightProvider).
  const walletAndMidnightProvider = createWalletAndMidnightProvider(facade, keys);
  const accountId = walletAndMidnightProvider.getCoinPublicKey();

  return {
    // Manages the private state of a contract, plus contract-maintenance
    // signing keys.
    // Key methods: get(id)→PS|null, set(id, PS), remove, clear,
    //              getSigningKey/setSigningKey (keyed by contract address),
    //              exportPrivateStates/importPrivateStates.
    // Storage is LevelDB (browser: IndexedDB): clearing the store permanently
    // destroys it — the package itself warns against production use where
    // loss matters. Fine here: our private state is just the identity secret
    // the caller already holds in env/config, so nothing is lost with the DB.
    privateStateProvider: levelPrivateStateProvider({
      // Sublevel for private states, keyed by privateStateId.
      // Default 'private-states' (in db 'midnight-level-db').
      // Set to prevent collision with other dApps.
      privateStateStoreName: "vault-private-states",

      // Sublevel for contract-maintenance signing keys, keyed by contract
      // address; written on deployContract. Default 'signing-keys'.
      // Set to prevent collision with other dApps.
      signingKeyStoreName: "vault-signing-keys",

      // Account identifier used to scope storage — isolates data between
      // different accounts/wallets using the same database.
      accountId,

      // Returns the password (sync or async) used to encrypt BOTH stores.
      // Must pass validatePassword: ≥16 chars, ≥3 of {upper,lower,digit,
      // special}, no 3+ repeated chars, no 4+ sequential runs — else
      // PasswordValidationError at runtime. A constant in client source is
      // obfuscation, not secrecy — acceptable here only because nothing
      // sensitive is stored. (Kept constant rather than derived from the
      // account id: derived hex could trip the repeat/sequence rules, and
      // per-account isolation already comes from `accountId` scoping.)
      privateStoragePasswordProvider: () => "&*(BHJqwe419-erc20Vault",
    }),

    // Retrieves public data from the blockchain.
    // Key methods: queryContractState(addr), watchForContractState,
    // contractStateObservable(addr).
    publicDataProvider: indexerPublicDataProvider({
      queryURL: config.indexerUrl,
      subscriptionURL: config.indexerWsUrl,
    }),

    zkConfigProvider,

    // Creates proven, unbalanced transactions (proves the contract-call
    // transcript). This is NOT the wallet's proving config: the facade's
    // proof server only proves the wallet's own balancing additions when it
    // finalizes a recipe; the call transcript is proven here first. Spans the
    // vault AND the signet contract so deposit's cross-contract call
    // resolves keys for the whole call tree.
    proofProvider: createCrossContractProofServerProvider(config.proofServerUrl, [
      zkConfigProvider,
      signetZkConfigProvider,
    ]),

    // Creates proven, balanced transactions.
    walletProvider: walletAndMidnightProvider,

    // Submits proven, balanced transactions to the network.
    midnightProvider: walletAndMidnightProvider,
  };
}
