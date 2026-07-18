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
  // Stagenet's endpoints are deliberately NOT published in this repo.
  // Provide them via the environment (repo-root .env), which
  // getMidnightNodeConfig REQUIRES for this network:
  //   MIDNIGHT_NODE_URL             — node RPC
  //   MIDNIGHT_NODE_INDEXER_URL     — indexer GraphQL over HTTP (the WS
  //                                   twin derives from it when unset)
  //   MIDNIGHT_NODE_INDEXER_WS_URL  — indexer GraphQL over WebSocket
  // The proof server stays local (it sees private witness data).
  ["stagenet"]: {
    indexerUrl: "",
    indexerWsUrl: "",
    nodeUrl: "",
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
// has no entry. Stagenet's faucet URL is deliberately NOT published in this
// repo — provide it via the MIDNIGHT_FAUCET_URL environment variable (see
// {@link getFaucetUrl}); without it the hint degrades to a generic "fund via
// the network's faucet". The public *.midnight.network faucet URLs are
// omitted until confirmed.
export const FAUCET_URLS: Partial<Record<NetworkId, string>> = {};

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
  return env.MIDNIGHT_FAUCET_URL?.trim() || FAUCET_URLS[networkId];
}

// Derive the indexer WebSocket URL from the indexer HTTP URL: swap the scheme
// to ws(s) and append the "/ws" path segment the indexer expects.
export function indexerWsUrlFromIndexerUrl(indexerUrl: string): string {
  const url = new URL(indexerUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  return url.toString();
}

/**
 * Read a {@link MidnightNodeConfig} from the environment. With nothing set
 * this yields the local "undeployed" stack; a network with blank defaults
 * (stagenet — its endpoints are not published in this repo) REQUIRES the
 * endpoint variables and fails naming the missing ones.
 *
 * Parse flow:
 * 1. `NETWORK_ID` (default "undeployed", validated against {@link NETWORK_IDS})
 *    selects the {@link DEFAULT_ENDPOINTS} baseline.
 * 2. Per-URL overrides then replace individual baseline endpoints:
 *    `MIDNIGHT_NODE_URL`, `MIDNIGHT_NODE_INDEXER_URL`,
 *    `MIDNIGHT_NODE_INDEXER_WS_URL`, `MIDNIGHT_NODE_PROOF_SERVER_URL`.
 *    When the indexer URL is overridden without a WS override, the WS URL is
 *    derived from it instead of keeping the baseline host.
 * 3. Every resolved endpoint must be non-empty.
 *
 * @throws If `NETWORK_ID` is unknown, or an endpoint resolves empty (blank
 *   default and no environment override).
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

  const config: MidnightNodeConfig = {
    networkId,
    indexerUrl,
    indexerWsUrl,
    nodeUrl: env.MIDNIGHT_NODE_URL || defaults.nodeUrl,
    proofServerUrl: env.MIDNIGHT_NODE_PROOF_SERVER_URL || defaults.proofServerUrl,
  };

  // A blank default means the network's endpoints are not published in this
  // repo (stagenet) — the environment must supply them, so fail with the
  // exact variables to set.
  const missing: string[] = [];
  if (!config.nodeUrl) missing.push("MIDNIGHT_NODE_URL");
  if (!config.indexerUrl) missing.push("MIDNIGHT_NODE_INDEXER_URL");
  if (!config.indexerWsUrl) missing.push("MIDNIGHT_NODE_INDEXER_WS_URL");
  if (!config.proofServerUrl) missing.push("MIDNIGHT_NODE_PROOF_SERVER_URL");
  if (missing.length > 0) {
    throw new Error(
      `network "${networkId}" has no built-in endpoints in this repo — set ${missing.join(", ")} ` +
        `in the environment (or the repo-root .env).`,
    );
  }

  return config;
}
