// Midnight node connection config — everything needed to talk to one Midnight
// network.

import {
  type MidnightNetwork as PublicMidnightNetwork,
  networks,
} from "@midnight-ntwrk/midnight-js/utils";

import { envOrUndefined } from "./env.ts";
import { MidnightNetwork, NETWORK_IDS, type NetworkId } from "./network-id.ts";

/**
 * The set of endpoints (+ network id) needed to reach the chain. Plain data,
 * so it can be handed to domain classes/functions by argument rather than
 * having them reach for a global. A seed is intentionally NOT part of this:
 * this config describes a *network*, while a seed identifies a *wallet*.
 */
export interface MidnightNodeConfig {
  readonly indexerUrl: string; // indexer GraphQL over HTTP
  readonly indexerWsUrl: string; // indexer GraphQL over WebSocket (subscriptions / sync)
  readonly nodeUrl: string; // Midnight node RPC (HTTP; converted to ws:// for the facade relay)
  readonly proofServerUrl: string; // proof server (ZK proof generation)
  readonly networkId: NetworkId; // which network these endpoints belong to
}

/** The environment variable that sets each {@link MidnightNodeConfig} field. */
export const MIDNIGHT_NODE_CONFIG_ENV_VARS = {
  networkId: "NETWORK_ID",
  nodeUrl: "MIDNIGHT_NODE_URL",
  indexerUrl: "MIDNIGHT_NODE_INDEXER_URL",
  indexerWsUrl: "MIDNIGHT_NODE_INDEXER_WS_URL",
  proofServerUrl: "MIDNIGHT_NODE_PROOF_SERVER_URL",
} as const satisfies Record<keyof MidnightNodeConfig, string>;

/** The environment variable that names the faucet (see {@link getFaucetUrl}). */
export const FAUCET_URL_ENV_VAR = "MIDNIGHT_FAUCET_URL";

/** A network's four service endpoints, without the network id itself. */
export type Endpoints = Omit<MidnightNodeConfig, "networkId">;

// The proof server sees private witness data, so it is always run locally
// rather than against a remote host.
/** Endpoint of the locally run proof server. */
export const LOCAL_PROOF_SERVER = "http://127.0.0.1:6300";

/** The environment variable carrying the Blockfrost project token (see {@link getMidnightNodeConfig}). */
export const BLOCKFROST_PROJECT_ID_ENV_VAR = "BLOCKFROST_PROJECT_ID";

/**
 * Faucet URLs per test network, for the fund-your-wallet hint: the
 * Nethermind-hosted Midnight faucets for preview and preprod. Mainnet carries
 * real value and has no faucet, and the local standalone chain funds via
 * genesis, so neither has an entry. The
 * MIDNIGHT_FAUCET_URL environment variable overrides any entry and supplies
 * one where there is none (see {@link getFaucetUrl}), and without either the
 * hint degrades to a generic "fund via the network's faucet".
 */
export const FAUCET_URLS: Partial<Record<NetworkId, string>> = {
  [MidnightNetwork.Preview]: "https://midnight-tmnight-preview.nethermind.dev",
  [MidnightNetwork.Preprod]: "https://midnight-tmnight-preprod.nethermind.dev",
};

/**
 * The faucet URL to show in underfunded-wallet hints: `MIDNIGHT_FAUCET_URL`
 * from the environment when set, else the network's {@link FAUCET_URLS}
 * entry. Purely informational — a missing URL only makes the hint generic.
 *
 * @param env - The environment to read `MIDNIGHT_FAUCET_URL` from.
 * @param networkId - The network whose faucet the hint points at.
 * @returns The faucet URL, or undefined when none is known.
 */
export function getFaucetUrl(
  env: Record<string, string | undefined>,
  networkId: NetworkId,
): string | undefined {
  return envOrUndefined(env, FAUCET_URL_ENV_VAR) ?? FAUCET_URLS[networkId];
}

// Derive the indexer WebSocket URL from the indexer HTTP URL: swap the scheme
// to ws(s) and append the "/ws" path segment the indexer expects.
/**
 * @param indexerUrl - The indexer's HTTP GraphQL endpoint.
 * @returns The same endpoint over ws(s), with the `/ws` segment appended.
 */
export function indexerWsUrlFromIndexerUrl(indexerUrl: string): string {
  const url = new URL(indexerUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  return url.toString();
}

/**
 * Read and validate the network id from the environment.
 *
 * @param env - The environment to read `NETWORK_ID` from.
 * @returns The named network, the local "undeployed" stack when unset.
 * @throws {Error} If `NETWORK_ID` names no known network.
 */
export function getNetworkId(env: Record<string, string | undefined>): MidnightNetwork {
  const raw =
    envOrUndefined(env, MIDNIGHT_NODE_CONFIG_ENV_VARS.networkId) ?? MidnightNetwork.Undeployed;
  for (const known of Object.values(MidnightNetwork)) {
    const id: string = known;
    if (id === raw) return known;
  }
  throw new Error(`Invalid NETWORK_ID "${raw}": expected one of ${NETWORK_IDS.join(", ")}.`);
}

const UNDEPLOYED_ENDPOINTS: Endpoints = {
  indexerUrl: "http://127.0.0.1:8088/api/v4/graphql",
  indexerWsUrl: "ws://127.0.0.1:8088/api/v4/graphql/ws",
  nodeUrl: "http://127.0.0.1:9944",
  proofServerUrl: LOCAL_PROOF_SERVER,
};

function endpointsOf(network: PublicMidnightNetwork): Endpoints {
  return {
    indexerUrl: network.indexer.queryURL,
    indexerWsUrl: network.indexer.subscriptionURL,
    nodeUrl: network.nodeURL,
    proofServerUrl: LOCAL_PROOF_SERVER,
  };
}

// Preprod and mainnet are served by Blockfrost, which answers only requests
// carrying a project token, so neither has endpoints until a token is known.
function builtInEndpoints(
  env: Record<string, string | undefined>,
  networkId: MidnightNetwork,
): Endpoints | undefined {
  const blockfrostProjectId = envOrUndefined(env, BLOCKFROST_PROJECT_ID_ENV_VAR);
  switch (networkId) {
    case MidnightNetwork.Undeployed:
      return UNDEPLOYED_ENDPOINTS;
    case MidnightNetwork.Preview:
      return endpointsOf(networks.preview());
    case MidnightNetwork.Preprod:
      return blockfrostProjectId === undefined
        ? undefined
        : endpointsOf(networks.preprod(blockfrostProjectId));
    case MidnightNetwork.Mainnet:
      return blockfrostProjectId === undefined
        ? undefined
        : endpointsOf(networks.mainnet(blockfrostProjectId));
  }
}

/**
 * Read a {@link MidnightNodeConfig} from the environment. With nothing set
 * this yields the local "undeployed" stack, and `NETWORK_ID` alone is enough
 * to reach preview. Preprod and mainnet are served by Blockfrost, so they
 * need either `BLOCKFROST_PROJECT_ID` (a token of a Blockfrost project for
 * that network, from blockfrost.io) or both `MIDNIGHT_NODE_URL` and
 * `MIDNIGHT_NODE_INDEXER_URL` naming a self-hosted node and indexer.
 *
 * The node and indexer URLs of a Blockfrost network carry the token as a
 * `project_id` query parameter: render them through `redactUrlQuery` before
 * logging.
 *
 * Parse flow:
 * 1. `NETWORK_ID` (default "undeployed", see {@link getNetworkId}) selects
 *    the built-in endpoints.
 * 2. Per-URL overrides then replace individual built-in endpoints:
 *    `MIDNIGHT_NODE_URL`, `MIDNIGHT_NODE_INDEXER_URL`,
 *    `MIDNIGHT_NODE_INDEXER_WS_URL`, `MIDNIGHT_NODE_PROOF_SERVER_URL`.
 *    When the indexer URL is overridden without a WS override, the WS URL is
 *    derived from it, keeping the pair on one host.
 *
 * @param env - The environment to read; defaults to `process.env`.
 * @returns The fully resolved node config.
 * @throws {Error} If `NETWORK_ID` is unknown, or the network is preprod or
 *   mainnet and the environment carries neither a Blockfrost project token
 *   nor both URL overrides.
 */
export function getMidnightNodeConfig(
  env: Record<string, string | undefined> = process.env,
): MidnightNodeConfig {
  const networkId = getNetworkId(env);
  const builtIn = builtInEndpoints(env, networkId);
  const indexerOverride = envOrUndefined(env, MIDNIGHT_NODE_CONFIG_ENV_VARS.indexerUrl);
  const nodeUrl = envOrUndefined(env, MIDNIGHT_NODE_CONFIG_ENV_VARS.nodeUrl) ?? builtIn?.nodeUrl;
  const indexerUrl = indexerOverride ?? builtIn?.indexerUrl;
  if (nodeUrl === undefined || indexerUrl === undefined) {
    throw new Error(
      `NETWORK_ID "${networkId}" is served by Blockfrost: set ${BLOCKFROST_PROJECT_ID_ENV_VAR} to the ` +
        `project id of a "Midnight ${networkId}" project from https://blockfrost.io, or set both ` +
        `${MIDNIGHT_NODE_CONFIG_ENV_VARS.nodeUrl} and ${MIDNIGHT_NODE_CONFIG_ENV_VARS.indexerUrl} ` +
        `to a node and indexer you run.`,
    );
  }
  const indexerWsUrl =
    envOrUndefined(env, MIDNIGHT_NODE_CONFIG_ENV_VARS.indexerWsUrl) ??
    (indexerOverride === undefined
      ? (builtIn?.indexerWsUrl ?? indexerWsUrlFromIndexerUrl(indexerUrl))
      : indexerWsUrlFromIndexerUrl(indexerUrl));

  return {
    networkId,
    indexerUrl,
    indexerWsUrl,
    nodeUrl,
    proofServerUrl:
      envOrUndefined(env, MIDNIGHT_NODE_CONFIG_ENV_VARS.proofServerUrl) ?? LOCAL_PROOF_SERVER,
  };
}
