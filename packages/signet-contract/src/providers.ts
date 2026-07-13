// The signet contract's midnight-js provider set — everything SPECIFIC about
// talking to a deployed instance: the compiled-contract binding (generated
// module + this package's managed assets), the zk-config path the proof
// provider reads keys from, the circuit-id union, and the private-state
// store id. The generic wallet + adapter live in midnight-plumbing.ts
// (private copies of lib's — this package is published, lib is not);
// clients compose the two and call `findDeployedContract(providers, ...)` to
// obtain a handle whose `callTx.postSignatureResponse(...)` /
// `callTx.postRespondBidirectional(...)` posts a response.
//
// Modeled on vault-contract/src/providers.ts.

import { fileURLToPath } from "node:url";

import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import type { MidnightProviders } from "@midnight-ntwrk/midnight-js/types";
import type { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";

import {
  createProofServerProvider,
  createWalletAndMidnightProvider,
  makeVacantCompiledContract,
  type AccountKeys,
  type MidnightNodeConfig,
} from "./midnight-plumbing.ts";

import { Contract } from "./managed/contract/index.js";
import { type SignetContractPrivateState } from "./witnesses.ts";

// Re-exported so consumers can name the parameter types of
// buildSignetContractProviders without reaching into internals.
export type { AccountKeys, MidnightNodeConfig } from "./midnight-plumbing.ts";

/** The contract's provable circuit ids, straight from the generated contract. */
export type SignetContractCircuitId = keyof InstanceType<typeof Contract>["provableCircuits"] & string;

/**
 * Literal of the private-state storage key. Just a string, but a single-value
 * union so the providers/`findDeployedContract` pairing is enforced by the
 * type system.
 */
export type SignetContractPrivateStateId = "signet-contract";

/**
 * Key under which midnight-js persists this contract's private state locally
 * (in the private-state store from {@link buildSignetContractProviders}).
 * Distinct per contract so two clients don't share an entry.
 */
export const SIGNET_CONTRACT_PRIVATE_STATE_ID: SignetContractPrivateStateId = "signet-contract";

/** The full midnight-js provider set, typed to the signet contract. */
export type SignetContractProviders = MidnightProviders<
  // PCK: the union of the contract's provable circuit names.
  SignetContractCircuitId,
  // PSI: the private-state storage key literal.
  SignetContractPrivateStateId,
  // PS: the shape of the contract's (empty) private state object.
  SignetContractPrivateState
>;

// The compiler output dir (holds contract/, keys/, zkir/) — the "zk config
// root" the proof + zk-config providers read proving/verifier keys from.
const managedPath = fileURLToPath(new URL("./managed", import.meta.url));

/**
 * The signet-contract compact-js compiled-contract binding: generated module
 * (the contract declares no witnesses) and this package's compiled assets.
 * Consumed by `findDeployedContract` (and deploy tooling).
 */
export const signetContractCompiledContract = makeVacantCompiledContract<
  Contract<SignetContractPrivateState>,
  SignetContractPrivateState
>(
  "signet-contract",
  Contract,
  managedPath,
);

/**
 * Build the midnight-js provider set for the signet contract.
 *
 * NOTE on proving keys: the npm-published package ships the compiled contract,
 * zkir and VERIFIER keys, but NOT the prover keys (hundreds of MB). In the
 * monorepo the default zk-config root works after `yarn compile:zk`; npm
 * consumers that SUBMIT call transactions (e.g. a response server posting
 * `postRespondBidirectional`) must pass `options.zkConfigPath` pointing at a
 * full `compact compile` output dir for this contract (`contract/`, `keys/`,
 * `zkir/`).
 *
 * @param facade - A started (and synced) wallet facade.
 * @param keys - The key material of the same wallet, for balancing and signing.
 * @param config - The Midnight network endpoints to run against.
 * @param options - `zkConfigPath` overrides the zk-config root the proof
 *   provider reads proving/verifier keys from (default: this package's
 *   bundled `managed/` output).
 * @returns The provider set to hand to `findDeployedContract` / `deployContract`.
 */
export function buildSignetContractProviders(
  facade: WalletFacade,
  keys: AccountKeys,
  config: MidnightNodeConfig,
  options?: { zkConfigPath?: string },
): SignetContractProviders {
  // Retrieves the ZK artifacts of a contract needed to create proofs.
  const zkConfigProvider = new NodeZkConfigProvider<SignetContractCircuitId>(
    options?.zkConfigPath ?? managedPath,
  );

  // The wallet, adapted to midnight-js's balancer + submitter interfaces
  // (the facade itself does not implement WalletProvider/MidnightProvider).
  const walletAndMidnightProvider = createWalletAndMidnightProvider(facade, keys);
  const accountId = walletAndMidnightProvider.getCoinPublicKey();

  return {
    // Manages the private state of a contract, plus contract-maintenance
    // signing keys. Store names are package-scoped to avoid collision with
    // other dApps sharing the same LevelDB. This contract's private state is
    // empty, so nothing is lost if the store is cleared.
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: "signet-contract-private-states",
      signingKeyStoreName: "signet-contract-signing-keys",
      accountId,
      // A constant in client source is obfuscation, not secrecy — acceptable
      // here only because nothing sensitive is stored (empty private state).
      privateStoragePasswordProvider: () => "&*(BHJqwe419-signetContract",
    }),

    // Retrieves public data from the blockchain.
    publicDataProvider: indexerPublicDataProvider({
      queryURL: config.indexerUrl,
      subscriptionURL: config.indexerWsUrl,
    }),

    zkConfigProvider,

    // Creates proven, unbalanced transactions (proves the contract-call
    // transcript). Distinct from the wallet's own balancing proofs.
    proofProvider: createProofServerProvider(config.proofServerUrl, zkConfigProvider),

    // Creates proven, balanced transactions.
    walletProvider: walletAndMidnightProvider,

    // Submits proven, balanced transactions to the network.
    midnightProvider: walletAndMidnightProvider,
  };
}
