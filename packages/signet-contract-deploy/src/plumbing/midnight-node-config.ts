// Midnight node connection config — everything needed to talk to one Midnight

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

/** A network's four service endpoints, without the network id itself. */
export type Endpoints = Omit<MidnightNodeConfig, "networkId">;

// The proof server sees private witness data, so it is always run locally
// rather than against a remote host.
/** Endpoint of the locally run proof server. */
export const LOCAL_PROOF_SERVER = "http://127.0.0.1:6300";

// Default endpoints per network. Undeployed is the local standalone stack
// (Docker containers) run during development.
/** Baseline endpoints per network, before any environment override. */
export const DEFAULT_ENDPOINTS: Record<NetworkId, Endpoints> = {
  [MidnightNetwork.Undeployed]: {
    indexerUrl: "http://127.0.0.1:8088/api/v3/graphql",
    indexerWsUrl: "ws://127.0.0.1:8088/api/v3/graphql/ws",
    nodeUrl: "http://127.0.0.1:9944",
    proofServerUrl: LOCAL_PROOF_SERVER,
  },
  // Stagenet runs the v4 indexer API, so its indexer paths differ from the
  // v3 paths of the *.midnight.network networks below.
  [MidnightNetwork.Stagenet]: {
    indexerUrl: "https://indexer.stagenet.shielded.tools/api/v4/graphql",
    indexerWsUrl: "wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws",
    nodeUrl: "https://rpc.stagenet.shielded.tools",
    proofServerUrl: LOCAL_PROOF_SERVER,
  },
  [MidnightNetwork.Preview]: {
    indexerUrl: "https://indexer.preview.midnight.network/api/v3/graphql",
    indexerWsUrl: "wss://indexer.preview.midnight.network/api/v3/graphql/ws",
    nodeUrl: "https://rpc.preview.midnight.network",
    proofServerUrl: LOCAL_PROOF_SERVER,
  },
  [MidnightNetwork.Preprod]: {
    indexerUrl: "https://indexer.preprod.midnight.network/api/v3/graphql",
    indexerWsUrl: "wss://indexer.preprod.midnight.network/api/v3/graphql/ws",
    nodeUrl: "https://rpc.preprod.midnight.network",
    proofServerUrl: LOCAL_PROOF_SERVER,
  },
  [MidnightNetwork.Mainnet]: {
    indexerUrl: "https://indexer.mainnet.midnight.network/api/v3/graphql",
    indexerWsUrl: "wss://indexer.mainnet.midnight.network/api/v3/graphql/ws",
    nodeUrl: "https://rpc.mainnet.midnight.network",
    proofServerUrl: LOCAL_PROOF_SERVER,
  },
};

/**
 * Faucet URLs per test network, for the fund-your-wallet hint: stagenet's
 * own faucet, and the Nethermind-hosted Midnight faucets for preview and
 * preprod. Mainnet carries real value and has no faucet, and the local
 * standalone chain funds via genesis, so neither has an entry. The
 * MIDNIGHT_FAUCET_URL environment variable overrides any entry and supplies
 * one where there is none (see {@link getFaucetUrl}), and without either the
 * hint degrades to a generic "fund via the network's faucet".
 */
export const FAUCET_URLS: Partial<Record<NetworkId, string>> = {
  [MidnightNetwork.Stagenet]: "https://faucet.stagenet.shielded.tools",
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
  return envOrUndefined(env, "MIDNIGHT_FAUCET_URL") ?? FAUCET_URLS[networkId];
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
 * Read a {@link MidnightNodeConfig} from the environment. Every network has
 * complete built-in endpoints, so with nothing set this yields the local
 * "undeployed" stack, and `NETWORK_ID` alone is enough to reach a deployed
 * network.
 *
 * Parse flow:
 * 1. `NETWORK_ID` (default "undeployed", validated against {@link NETWORK_IDS})
 *    selects the {@link DEFAULT_ENDPOINTS} baseline.
 * 2. Per-URL overrides then replace individual baseline endpoints:
 *    `MIDNIGHT_NODE_URL`, `MIDNIGHT_NODE_INDEXER_URL`,
 *    `MIDNIGHT_NODE_INDEXER_WS_URL`, `MIDNIGHT_NODE_PROOF_SERVER_URL`.
 *    When the indexer URL is overridden without a WS override, the WS URL is
 *    derived from it, keeping the pair on one host.
 *
 * @param env - The environment to read; defaults to `process.env`.
 * @returns The fully resolved node config.
 * @throws {Error} If `NETWORK_ID` is unknown.
 */
export function getMidnightNodeConfig(
  env: Record<string, string | undefined> = process.env,
): MidnightNodeConfig {
  const networkId: NetworkId = envOrUndefined(env, "NETWORK_ID") ?? MidnightNetwork.Undeployed;
  // NetworkId widens the enum with the SDK's bare-string type, so the baseline
  // lookup can miss. Both failures name the same fix, so they share a throw.
  const defaults = DEFAULT_ENDPOINTS[networkId];
  if (!NETWORK_IDS.includes(networkId) || defaults === undefined) {
    throw new Error(
      `Invalid NETWORK_ID "${networkId}" — expected one of: ${NETWORK_IDS.join(", ")}.`,
    );
  }

  const indexerOverride = envOrUndefined(env, "MIDNIGHT_NODE_INDEXER_URL");
  const indexerUrl = indexerOverride ?? defaults.indexerUrl;
  const indexerWsUrl =
    envOrUndefined(env, "MIDNIGHT_NODE_INDEXER_WS_URL") ??
    (indexerOverride === undefined
      ? defaults.indexerWsUrl
      : indexerWsUrlFromIndexerUrl(indexerUrl));

  return {
    networkId,
    indexerUrl,
    indexerWsUrl,
    nodeUrl: envOrUndefined(env, "MIDNIGHT_NODE_URL") ?? defaults.nodeUrl,
    proofServerUrl:
      envOrUndefined(env, "MIDNIGHT_NODE_PROOF_SERVER_URL") ?? defaults.proofServerUrl,
  };
}
