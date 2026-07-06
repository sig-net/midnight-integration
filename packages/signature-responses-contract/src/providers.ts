// The signature-responses contract's midnight-js provider set — everything
// SPECIFIC about talking to a deployed instance: the compiled-contract binding
// (generated module + this package's managed assets), the zk-config path the
// proof provider reads keys from, the circuit-id union, and the private-state
// store id. The generic wallet + adapter come from @midnight-erc20-vault/lib;
// clients compose the two and call `findDeployedContract(providers, ...)` to
// obtain a handle whose `callTx.postSignatureResponse(...)` posts a response.
//
// Modeled on vault-contract/src/providers.ts. The one difference: this contract
// declares NO witnesses (posting is unauthenticated), so the compiled contract
// binds via `makeVacantCompiledContract` instead of `makeCompiledContract`.

import { fileURLToPath } from "node:url";

import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import type { MidnightProviders } from "@midnight-ntwrk/midnight-js/types";
import type { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";

import {
  createWalletAndMidnightProvider,
  makeVacantCompiledContract,
  type AccountKeys,
  type MidnightNodeConfig,
} from "@midnight-erc20-vault/lib";

import { Contract } from "./managed/contract/index.js";
import { type SignatureResponsesPrivateState } from "./witnesses.ts";

/** The contract's provable circuit ids, straight from the generated contract. */
export type SignatureResponseCircuitId = keyof InstanceType<typeof Contract>["provableCircuits"] & string;

/**
 * Literal of the private-state storage key. Just a string, but a single-value
 * union so the providers/`findDeployedContract` pairing is enforced by the
 * type system.
 */
export type SignatureResponsesPrivateStateId = "signature-responses";

/**
 * Key under which midnight-js persists this contract's private state locally
 * (in the private-state store from {@link buildSignatureResponseProviders}).
 * Distinct per contract so two clients don't share an entry.
 */
export const SIGNATURE_RESPONSES_PRIVATE_STATE_ID: SignatureResponsesPrivateStateId = "signature-responses";

/** The full midnight-js provider set, typed to the signature-responses contract. */
export type SignatureResponseProviders = MidnightProviders<
  // PCK: the union of the contract's provable circuit names.
  SignatureResponseCircuitId,
  // PSI: the private-state storage key literal.
  SignatureResponsesPrivateStateId,
  // PS: the shape of the contract's (empty) private state object.
  SignatureResponsesPrivateState
>;

// The compiler output dir (holds contract/, keys/, zkir/) — the "zk config
// root" the proof + zk-config providers read proving/verifier keys from.
const managedPath = fileURLToPath(new URL("./managed", import.meta.url));

/**
 * The signature-responses compact-js compiled-contract binding: generated
 * module + this package's compiled assets. Bound VACANT (no witnesses — see
 * the file header). Consumed by `findDeployedContract` (and deploy tooling).
 */
export const signatureResponsesCompiledContract = makeVacantCompiledContract<
  Contract<SignatureResponsesPrivateState>,
  SignatureResponsesPrivateState
>(
  "signature-responses",
  Contract,
  managedPath,
);

/**
 * Build the midnight-js provider set for the signature-responses contract.
 *
 * @param facade - A started (and synced) wallet facade — see lib's `withSyncedWalletFacade`.
 * @param keys - The key material of the same wallet, for balancing and signing.
 * @param config - The Midnight network endpoints to run against.
 * @returns The provider set to hand to `findDeployedContract` / `deployContract`.
 */
export function buildSignatureResponseProviders(
  facade: WalletFacade,
  keys: AccountKeys,
  config: MidnightNodeConfig,
): SignatureResponseProviders {
  // Retrieves the ZK artifacts of a contract needed to create proofs.
  const zkConfigProvider = new NodeZkConfigProvider<SignatureResponseCircuitId>(managedPath);

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
      privateStateStoreName: "signature-responses-private-states",
      signingKeyStoreName: "signature-responses-signing-keys",
      accountId,
      // A constant in client source is obfuscation, not secrecy — acceptable
      // here only because nothing sensitive is stored (empty private state).
      privateStoragePasswordProvider: () => "&*(BHJqwe419-sigResponses",
    }),

    // Retrieves public data from the blockchain.
    publicDataProvider: indexerPublicDataProvider(config.indexerUrl, config.indexerWsUrl),

    zkConfigProvider,

    // Creates proven, unbalanced transactions (proves the contract-call
    // transcript). Distinct from the wallet's own balancing proofs.
    proofProvider: httpClientProofProvider(config.proofServerUrl, zkConfigProvider),

    // Creates proven, balanced transactions.
    walletProvider: walletAndMidnightProvider,

    // Submits proven, balanced transactions to the network.
    midnightProvider: walletAndMidnightProvider,
  };
}
