// Midnight node connection config — everything needed to talk to one Midnight

import { NETWORK_IDS, type NetworkId } from "./network-id.ts";

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

export type Endpoints = Omit<MidnightNodeConfig, "networkId">;

// The proof server sees private witness data, so it is always run locally
// rather than against a remote host.
export const LOCAL_PROOF_SERVER = "http://127.0.0.1:6300";

// Default endpoints per network. Undeployed is the local standalone stack
// (Docker containers) run during development.
export const DEFAULT_ENDPOINTS: Record<NetworkId, Endpoints> = {
  ["undeployed"]: {
    indexerUrl: "http://127.0.0.1:8088/api/v3/graphql",
    indexerWsUrl: "ws://127.0.0.1:8088/api/v3/graphql/ws",
    nodeUrl: "http://127.0.0.1:9944",
    proofServerUrl: LOCAL_PROOF_SERVER,
  },
  ["stagenet"]: {
    indexerUrl: "https://indexer.stagenet.shielded.tools/api/v4/graphql",
    indexerWsUrl: "wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws",
    nodeUrl: "https://rpc.stagenet.shielded.tools",
    proofServerUrl: LOCAL_PROOF_SERVER,
  },
  ["preview"]: {
    indexerUrl: "https://indexer.preview.midnight.network/api/v3/graphql",
    indexerWsUrl: "wss://indexer.preview.midnight.network/api/v3/graphql/ws",
    nodeUrl: "https://rpc.preview.midnight.network",
    proofServerUrl: LOCAL_PROOF_SERVER,
  },
  ["preprod"]: {
    indexerUrl: "https://indexer.preprod.midnight.network/api/v3/graphql",
    indexerWsUrl: "wss://indexer.preprod.midnight.network/api/v3/graphql/ws",
    nodeUrl: "https://rpc.preprod.midnight.network",
    proofServerUrl: LOCAL_PROOF_SERVER,
  },
  ["mainnet"]: {
    indexerUrl: "https://indexer.mainnet.midnight.network/api/v3/graphql",
    indexerWsUrl: "wss://indexer.mainnet.midnight.network/api/v3/graphql/ws",
    nodeUrl: "https://rpc.mainnet.midnight.network",
    proofServerUrl: LOCAL_PROOF_SERVER,
  },
};

// Faucet URLs for the networks that publish one, for underfunded-wallet
// hints. The local standalone chain funds via genesis, not a faucet, so it
// has no entry; the public *.midnight.network faucet URLs are omitted until
// confirmed, so a hint there degrades to a generic "fund via the faucet".
// TODO: add faucet urls for other networks
export const FAUCET_URLS: Partial<Record<NetworkId, string>> = {
  ["stagenet"]: "https://faucet.stagenet.shielded.tools",
};

// Derive the indexer WebSocket URL from the indexer HTTP URL: swap the scheme
// to ws(s) and append the "/ws" path segment the indexer expects.
export function indexerWsUrlFromIndexerUrl(indexerUrl: string): string {
  const url = new URL(indexerUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  return url.toString();
}

/**
 * Read a {@link MidnightNodeConfig} from the environment. Every variable is
 * optional — with nothing set this yields the local "undeployed" stack.
 *
 * Parse flow:
 * 1. `NETWORK_ID` (default "undeployed", validated against {@link NETWORK_IDS})
 *    selects the {@link DEFAULT_ENDPOINTS} baseline.
 * 2. Per-URL overrides then replace individual baseline endpoints:
 *    `MIDNIGHT_NODE_URL`, `MIDNIGHT_NODE_INDEXER_URL`,
 *    `MIDNIGHT_NODE_INDEXER_WS_URL`, `MIDNIGHT_NODE_PROOF_SERVER_URL`.
 *    When the indexer URL is overridden without a WS override, the WS URL is
 *    derived from it instead of keeping the baseline host.
 */
export function getMidnightNodeConfig(
  env: Record<string, string | undefined> = process.env,
): MidnightNodeConfig {
  const networkId: NetworkId = env.NETWORK_ID?.trim() || "undeployed";
  if (!NETWORK_IDS.includes(networkId)) {
    throw new Error(`Invalid NETWORK_ID "${networkId}" — expected one of: ${NETWORK_IDS.join(", ")}.`);
  }

  const defaults = DEFAULT_ENDPOINTS[networkId];
  const indexerUrl = env.MIDNIGHT_NODE_INDEXER_URL || defaults.indexerUrl;
  const indexerWsUrl =
    env.MIDNIGHT_NODE_INDEXER_WS_URL ||
    (env.MIDNIGHT_NODE_INDEXER_URL ? indexerWsUrlFromIndexerUrl(indexerUrl) : defaults.indexerWsUrl);

  return {
    networkId,
    indexerUrl,
    indexerWsUrl,
    nodeUrl: env.MIDNIGHT_NODE_URL || defaults.nodeUrl,
    proofServerUrl: env.MIDNIGHT_NODE_PROOF_SERVER_URL || defaults.proofServerUrl,
  };
}
