// The caller's midnight-js provider set — everything CALLER-specific about
// talking to a deployed instance: the compiled-contract binding (generated
// module + witnesses + this package's managed assets), the zk-config path the
// proof provider reads keys from, the circuit-id union, and the private-state
// store id. The generic wallet comes from @sig-net/midnight-contract-deploy,
// the provider adapters from @midnight-protocol/lib; clients compose the
// pieces and call `findDeployedContract(providers, ...)`.

import { fileURLToPath } from "node:url";

import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import type { MidnightProviders } from "@midnight-ntwrk/midnight-js/types";
import type { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";

import {
  createCrossContractProofServerProvider,
  createWalletAndMidnightProvider,
} from "@midnight-protocol/lib";
import {
  makeVacantCompiledContract,
  type AccountKeys,
  type MidnightNodeConfig,
} from "@sig-net/midnight-contract-deploy";

import { Contract } from "./managed/signet-caller/contract/index.js";
import type { CallerPrivateState } from "./witnesses.ts";

/** The caller's provable circuit ids, straight from the generated contract. */
export type CallerCircuitId = keyof InstanceType<typeof Contract>["provableCircuits"] & string;

/**
 * Literal of the private-state storage key. Just a string, but a
 * single-value union so the providers/`findDeployedContract` pairing is
 * enforced by the type system.
 */
export type CallerPrivateStateId = "signet-caller";

/**
 * Key under which midnight-js persists the caller's (empty) private state
 * locally (in the private-state store from {@link buildCallerProviders}).
 * Distinct per contract so two clients don't share an entry.
 */
export const CALLER_PRIVATE_STATE_ID: CallerPrivateStateId = "signet-caller";

/** The full midnight-js provider set, typed to the caller. */
export type CallerProviders = MidnightProviders<
  // PCK: the union of the contract's provable circuit names.
  CallerCircuitId,
  // PSI: the private-state storage key literal.
  CallerPrivateStateId,
  // PS: the shape of the contract's (empty) private state object.
  CallerPrivateState
>;

// The compiler output dirs (each holds contract/, keys/, zkir/) — the "zk
// config roots" the proof + zk-config providers read proving/verifier keys
// from. submitSignatureRequest cross-contract-calls the signet contract, so
// proving spans both: signetManagedPath is a compile-time symlink to the
// deployed signet contract's managed output (see this package's compile
// script).
const managedPath = fileURLToPath(new URL("./managed/signet-caller", import.meta.url));
const signetManagedPath = fileURLToPath(new URL("./managed/SignetSigner", import.meta.url));

/**
 * The caller's compact-js compiled-contract binding: generated module (the
 * contract declares no witnesses) + this package's compiled assets. Consumed
 * by `findDeployedContract` (and the deploy flow in {@link deployCaller}).
 */
export const callerCompiledContract = makeVacantCompiledContract<Contract<CallerPrivateState>, CallerPrivateState>(
  "signet-caller",
  Contract,
  managedPath,
);

/**
 * Build the midnight-js provider set for the caller.
 *
 * @param facade - A started (and synced) wallet facade — see `withSyncedWalletFacade`.
 * @param keys - The key material of the same wallet, for balancing and signing.
 * @param config - The Midnight network endpoints to run against.
 * @returns The provider set to hand to `findDeployedContract` / `deployContract`.
 */
export function buildCallerProviders(
  facade: WalletFacade,
  keys: AccountKeys,
  config: MidnightNodeConfig,
): CallerProviders {
  // Retrieves the ZK artifacts of a contract needed to create proofs.
  const zkConfigProvider = new NodeZkConfigProvider<CallerCircuitId>(managedPath);

  // The callee (signet contract) circuits, resolved for the cross-contract
  // proof provider so submitSignatureRequest's whole call tree proves.
  const signetZkConfigProvider = new NodeZkConfigProvider<string>(signetManagedPath);

  // The wallet, adapted to midnight-js's balancer + submitter interfaces
  // (the facade itself does not implement WalletProvider/MidnightProvider).
  const walletAndMidnightProvider = createWalletAndMidnightProvider(facade, keys);
  const accountId = walletAndMidnightProvider.getCoinPublicKey();

  return {
    // Manages the private state of a contract, plus contract-maintenance
    // signing keys. Storage is LevelDB; nothing sensitive is stored here (the
    // caller's private state is empty), so the constant password below is
    // format compliance, not secrecy. Store names are distinct per contract
    // so two clients don't share an entry.
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: "signet-caller-private-states",
      signingKeyStoreName: "signet-caller-signing-keys",
      accountId,
      privateStoragePasswordProvider: () => "&*(BHJqwe419-signetCaller",
    }),

    // Retrieves public data from the blockchain.
    publicDataProvider: indexerPublicDataProvider({
      queryURL: config.indexerUrl,
      subscriptionURL: config.indexerWsUrl,
    }),

    zkConfigProvider,

    // Creates proven, unbalanced transactions (proves the contract-call
    // transcript). Spans the caller AND the signet contract so
    // submitSignatureRequest's cross-contract call resolves keys for the
    // whole call tree.
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
