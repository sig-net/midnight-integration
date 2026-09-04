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
  it.each(STANDALONE_CASES)(
    "isLocalStandaloneNetwork($networkId) === $expected",
    ({ networkId, expected }) => {
      expect(isLocalStandaloneNetwork(networkId)).toBe(expected);
    },
  );
});

describe("getMidnightNodeConfig for stagenet", () => {
  it("resolves the built-in endpoints from NETWORK_ID alone", () => {
    expect(getMidnightNodeConfig({ NETWORK_ID: "stagenet" })).toEqual({
      networkId: "stagenet",
      indexerUrl: "https://indexer.stagenet.shielded.tools/api/v4/graphql",
      indexerWsUrl: "wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws",
      nodeUrl: "https://rpc.stagenet.shielded.tools",
      proofServerUrl: "http://127.0.0.1:6300",
    });
  });

  it("resolves env-provided endpoints over the defaults (WS twin derived from the indexer URL)", () => {
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

  it("publishes the stagenet faucet URL, which MIDNIGHT_FAUCET_URL overrides", () => {
    expect(FAUCET_URLS.stagenet).toBe("https://faucet.stagenet.shielded.tools");
    expect(getFaucetUrl({}, "stagenet")).toBe("https://faucet.stagenet.shielded.tools");
    expect(getFaucetUrl({ MIDNIGHT_FAUCET_URL: "https://faucet.example" }, "stagenet")).toBe(
      "https://faucet.example",
    );
  });
});
