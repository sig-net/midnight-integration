// The two protocol counterparty values a requester contract seals for good:
// the signet singleton it notifies (a deploy-time constructor argument) and
// the MPC root public key its derived accounts and its response key start
// from (the response key derived from it is pinned at initialise). On a
// deployed network this SDK publishes both, so a deploy needs neither in its
// environment, and a value that IS set is checked against the published one:
// a mismatch would seal an address the real MPC
// never answers or a key it never signs under. The local standalone stack
// publishes nothing: its setup deploys a singleton and generates a root key
// per stack, and passes them through the same environment variables.

import {
  type DeployedNetwork,
  getMpcRootPublicKey,
  getSignetContractAddress,
  normaliseSecp256k1PublicKey,
  stripHexPrefix,
} from "@sig-net/midnight";

import { envOrUndefined } from "./env.ts";
import { getMidnightNodeConfig } from "./midnight-node-config.ts";
import { deployedNetwork, type NetworkId } from "./network-id.ts";

/** Which source supplied a resolved counterparty value. */
export enum CounterpartyOrigin {
  /** The environment variable named for it. */
  Environment = "environment",
  /** The value this SDK publishes for the network. */
  Published = "published",
}

/** A counterparty value in its canonical spelling, and where it came from. */
export interface ResolvedCounterparty {
  readonly value: string;
  readonly origin: CounterpartyOrigin;
}

/** One counterparty value: its variable, its canonical spelling, and what sealing it means. */
interface CounterpartySpec {
  readonly envVar: string;
  /** The value's name in messages, e.g. "the signet singleton". */
  readonly noun: string;
  readonly lookup: (network: DeployedNetwork) => string;
  /** The canonical spelling of an accepted value. Throws on a malformed one. */
  readonly canonicalise: (value: string) => string;
  /** Why an environment value must agree with the published one. */
  readonly disagreementConsequence: string;
  /** What to do when neither the environment nor the SDK supplies a value on the local stack. */
  readonly localStackRemedy: string;
}

/**
 * The SDK's published value for a network.
 *
 * @param networkId - The network the run resolved.
 * @param lookup - The published-value lookup (`getSignetContractAddress`, `getMpcRootPublicKey`).
 * @returns The value, or undefined for the local stack and for a deployed network the SDK
 *   holds no value for yet (the lookup throws there, and "not published yet" is a normal
 *   state for a young network).
 */
function published(
  networkId: NetworkId,
  lookup: (network: DeployedNetwork) => string,
): string | undefined {
  const network = deployedNetwork(networkId);
  if (network === undefined) return undefined;
  try {
    return lookup(network);
  } catch {
    return undefined;
  }
}

function find(
  env: Record<string, string | undefined>,
  spec: CounterpartySpec,
): ResolvedCounterparty | undefined {
  const { networkId } = getMidnightNodeConfig(env);
  const supplied = envOrUndefined(env, spec.envVar);
  const fromEnvironment = supplied === undefined ? undefined : spec.canonicalise(supplied);
  const publishedRaw = published(networkId, spec.lookup);
  const fromSdk = publishedRaw === undefined ? undefined : spec.canonicalise(publishedRaw);
  if (fromEnvironment !== undefined && fromSdk !== undefined && fromEnvironment !== fromSdk) {
    throw new Error(
      `${spec.envVar} (${fromEnvironment}) disagrees with ${spec.noun} the SDK publishes for ` +
        `"${networkId}" (${fromSdk}). ${spec.disagreementConsequence}`,
    );
  }
  if (fromEnvironment !== undefined) {
    return { value: fromEnvironment, origin: CounterpartyOrigin.Environment };
  }
  if (fromSdk !== undefined) {
    return { value: fromSdk, origin: CounterpartyOrigin.Published };
  }
  return undefined;
}

function resolve(
  env: Record<string, string | undefined>,
  spec: CounterpartySpec,
): ResolvedCounterparty {
  const found = find(env, spec);
  if (found !== undefined) return found;
  const { networkId } = getMidnightNodeConfig(env);
  const remedy =
    deployedNetwork(networkId) === undefined
      ? spec.localStackRemedy
      : `the SDK publishes no ${spec.noun.replace(/^the /, "")} for it yet`;
  throw new Error(`${spec.envVar} is required on "${networkId}": ${remedy}.`);
}

const SIGNET_CONTRACT_ADDRESS: CounterpartySpec = {
  envVar: "MIDNIGHT_SIGNET_CONTRACT_ADDRESS",
  noun: "the signet singleton",
  lookup: getSignetContractAddress,
  canonicalise: (value) => {
    const digits = stripHexPrefix(value);
    if (!/^[0-9a-fA-F]{64}$/.test(digits)) {
      throw new Error(
        `MIDNIGHT_SIGNET_CONTRACT_ADDRESS is not a 32-byte contract address in hex: "${value}"`,
      );
    }
    return digits.toLowerCase();
  },
  disagreementConsequence:
    "The real MPC answers only the published one, and a requester seals the address at deploy: " +
    "reconcile them before deploying.",
  localStackRemedy: "deploy one with deploySignetContract and set its address",
};

/**
 * The signet singleton a requester contract notifies, as 64 lowercase hex
 * digits: `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` when set (it must agree with the
 * singleton the SDK publishes for a deployed network), else that published
 * singleton.
 *
 * @param env - The environment to read `NETWORK_ID` and `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` from.
 * @returns The address and its origin, or undefined when neither source supplies one.
 * @throws {Error} If the variable is malformed or disagrees with the published singleton.
 */
export function findSignetContractAddress(
  env: Record<string, string | undefined>,
): ResolvedCounterparty | undefined {
  return find(env, SIGNET_CONTRACT_ADDRESS);
}

/**
 * {@link findSignetContractAddress}, failing when neither source supplies one.
 *
 * @param env - The environment to read `NETWORK_ID` and `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` from.
 * @returns The address and its origin.
 * @throws {Error} If the variable is malformed, disagrees with the published singleton, or
 *   is unset on a network the SDK publishes no singleton for.
 */
export function resolveSignetContractAddress(
  env: Record<string, string | undefined>,
): ResolvedCounterparty {
  return resolve(env, SIGNET_CONTRACT_ADDRESS);
}

const MPC_ROOT_PUBLIC_KEY: CounterpartySpec = {
  envVar: "MPC_SECP256K1_PUBKEY",
  noun: "the MPC root public key",
  lookup: getMpcRootPublicKey,
  canonicalise: normaliseSecp256k1PublicKey,
  disagreementConsequence:
    "One of the two is wrong, and the key is sealed into every derived account: reconcile them " +
    "before deploying.",
  localStackRemedy:
    "set it to the root public key of the MPC facing this stack (a fakenet derives it from its " +
    "MPC_ROOT_KEY)",
};

/**
 * The MPC root public key every client key derivation starts from, as
 * `0x04…` uncompressed SEC1 hex: `MPC_SECP256K1_PUBKEY` in any spelling
 * `normaliseSecp256k1PublicKey` accepts when set (it must agree with the key
 * the SDK publishes for a deployed network), else that published key.
 *
 * @param env - The environment to read `NETWORK_ID` and `MPC_SECP256K1_PUBKEY` from.
 * @returns The key and its origin, or undefined when neither source supplies one.
 * @throws {Error} If the variable is not a secp256k1 public key or disagrees with the published key.
 */
export function findMpcRootPublicKey(
  env: Record<string, string | undefined>,
): ResolvedCounterparty | undefined {
  return find(env, MPC_ROOT_PUBLIC_KEY);
}

/**
 * {@link findMpcRootPublicKey}, failing when neither source supplies one.
 *
 * @param env - The environment to read `NETWORK_ID` and `MPC_SECP256K1_PUBKEY` from.
 * @returns The key and its origin.
 * @throws {Error} If the variable is not a secp256k1 public key, disagrees with the published
 *   key, or is unset on a network the SDK publishes no key for.
 */
export function resolveMpcRootPublicKey(
  env: Record<string, string | undefined>,
): ResolvedCounterparty {
  return resolve(env, MPC_ROOT_PUBLIC_KEY);
}
