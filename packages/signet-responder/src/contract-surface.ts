// The contract's platform-agnostic client surface: the circuit-id union, the
// private-state store key, and the provider-set TYPE. Deliberately nothing
// runnable: composing a live midnight-js provider set differs per environment
// (Node fs vs browser fetch, LevelDB vs IndexedDB, WalletFacade vs a connector
// API), so each consumer declares its own.

import type { MidnightProviders } from "@midnight-ntwrk/midnight-js/types";

import type { Contract } from "./managed/contract/index.js";
import type { SignetResponderPrivateState } from "./witnesses.ts";

/** The contract's provable circuit ids, straight from the generated contract. */
export type SignetResponderCircuitId = keyof InstanceType<typeof Contract>["provableCircuits"];

/**
 * Literal of the private-state storage key. Just a string, but a single-value
 * union so the providers/`findDeployedContract` pairing is enforced by the
 * type system.
 */
export type SignetResponderPrivateStateId = "signet-responder";

/**
 * Key under which midnight-js persists this contract's private state locally
 * (in whatever private-state store the consumer's provider set uses).
 * Distinct per contract so two clients don't share an entry.
 */
export const SIGNET_RESPONDER_PRIVATE_STATE_ID: SignetResponderPrivateStateId = "signet-responder";

/** The full midnight-js provider set, typed to the signet responder. */
export type SignetResponderProviders = MidnightProviders<
  // PCK: the union of the contract's provable circuit names.
  SignetResponderCircuitId,
  // PSI: the private-state storage key literal.
  SignetResponderPrivateStateId,
  // PS: the shape of the contract's (empty) private state object.
  SignetResponderPrivateState
>;
