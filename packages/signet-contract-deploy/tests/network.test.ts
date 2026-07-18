// Network identity + endpoint resolution. Pure — no network, no crypto.

import { describe, expect, it } from "vitest";

import {
  FAUCET_URLS,
  getFaucetUrl,
  getMidnightNodeConfig,
  isLocalStandaloneNetwork,
  NETWORK_IDS,
  type NetworkId,
} from "../src/index.ts";

describe("network ids", () => {
  it("includes stagenet", () => {
    expect(NETWORK_IDS).toContain("stagenet");
  });

  interface StandaloneCase {
    networkId: NetworkId;
    expected: boolean;
  }
  const STANDALONE_CASES: StandaloneCase[] = [
    { networkId: "undeployed", expected: true },
    { networkId: "preview", expected: false },
    { networkId: "preprod", expected: false },
    { networkId: "stagenet", expected: false },
    { networkId: "mainnet", expected: false },
  ];
  it.each(STANDALONE_CASES)("isLocalStandaloneNetwork($networkId) === $expected", ({ networkId, expected }) => {
    expect(isLocalStandaloneNetwork(networkId)).toBe(expected);
  });
});

// Stagenet's endpoints are deliberately not published in this repo: the
// defaults are blank and the environment must supply them.
describe("getMidnightNodeConfig for stagenet", () => {
  it("REQUIRES the endpoint env vars, failing with the exact names to set", () => {
    expect(() => getMidnightNodeConfig({ NETWORK_ID: "stagenet" })).toThrow(
      /MIDNIGHT_NODE_URL, MIDNIGHT_NODE_INDEXER_URL, MIDNIGHT_NODE_INDEXER_WS_URL/,
    );
  });

  it("resolves env-provided endpoints (WS twin derived from the indexer URL)", () => {
    const config = getMidnightNodeConfig({
      NETWORK_ID: "stagenet",
      MIDNIGHT_NODE_URL: "https://node.example",
      MIDNIGHT_NODE_INDEXER_URL: "https://indexer.example/api/v4/graphql",
    });
    expect(config).toEqual({
      networkId: "stagenet",
      indexerUrl: "https://indexer.example/api/v4/graphql",
      indexerWsUrl: "wss://indexer.example/api/v4/graphql/ws",
      nodeUrl: "https://node.example",
      proofServerUrl: "http://127.0.0.1:6300",
    });
  });

  it("publishes no stagenet faucet URL; MIDNIGHT_FAUCET_URL supplies one", () => {
    expect(FAUCET_URLS.stagenet).toBeUndefined();
    expect(getFaucetUrl({}, "stagenet")).toBeUndefined();
    expect(getFaucetUrl({ MIDNIGHT_FAUCET_URL: "https://faucet.example" }, "stagenet")).toBe(
      "https://faucet.example",
    );
  });
});
