// The contract's platform-agnostic client surface: the circuit-id union, the
// private-state store key, and the provider-set TYPE. Deliberately nothing
// runnable — no wallet flavor, no zk-config source, no state store, no proof
// provider. Composing a live midnight-js provider set is CONSUMER territory
// (it differs per environment: Node fs vs browser fetch, LevelDB vs
// IndexedDB, WalletFacade vs a connector API), so each consumer declares its
// own — see this monorepo's signet-contract-deploy package for the Node
// operator composition.

import type { MidnightProviders } from "@midnight-ntwrk/midnight-js/types";

import type { Contract } from "./managed/contract/index.js";
import type { SignetSignerPrivateState } from "./witnesses.ts";

/** The contract's provable circuit ids, straight from the generated contract. */
export type SignetSignerCircuitId = keyof InstanceType<typeof Contract>["provableCircuits"];

/**
 * Literal of the private-state storage key. Just a string, but a single-value
 * union so the providers/`findDeployedContract` pairing is enforced by the
 * type system.
 */
export type SignetSignerPrivateStateId = "signet-signer";

/**
 * Key under which midnight-js persists this contract's private state locally
 * (in whatever private-state store the consumer's provider set uses).
 * Distinct per contract so two clients don't share an entry.
 */
export const SIGNET_SIGNER_PRIVATE_STATE_ID: SignetSignerPrivateStateId = "signet-signer";

/** The full midnight-js provider set, typed to the signet signer. */
export type SignetSignerProviders = MidnightProviders<
  // PCK: the union of the contract's provable circuit names.
  SignetSignerCircuitId,
  // PSI: the private-state storage key literal.
  SignetSignerPrivateStateId,
  // PS: the shape of the contract's (empty) private state object.
  SignetSignerPrivateState
>;
