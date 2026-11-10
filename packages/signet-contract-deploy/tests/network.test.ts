// Network identity + endpoint resolution. Pure — no network, no crypto.

import { describe, expect, it } from "vitest";

import {
  FAUCET_URLS,
  getFaucetUrl,
  getMidnightNodeConfig,
  isLocalStandaloneNetwork,
  type NetworkId,
} from "../src/index.ts";

describe("network ids", () => {
  interface StandaloneCase {
    networkId: NetworkId;
    expected: boolean;
  }
  const STANDALONE_CASES: StandaloneCase[] = [
    { networkId: "undeployed", expected: true },
    { networkId: "preview", expected: false },
    { networkId: "preprod", expected: false },
    { networkId: "mainnet", expected: false },
  ];
  it.each(STANDALONE_CASES)(
    "isLocalStandaloneNetwork($networkId) === $expected",
    ({ networkId, expected }) => {
      expect(isLocalStandaloneNetwork(networkId)).toBe(expected);
    },
  );
});

describe("getMidnightNodeConfig for preview", () => {
  it("resolves the built-in endpoints from NETWORK_ID alone", () => {
    expect(getMidnightNodeConfig({ NETWORK_ID: "preview" })).toEqual({
      networkId: "preview",
      indexerUrl: "https://indexer.preview.midnight.network/api/v4/graphql",
      indexerWsUrl: "wss://indexer.preview.midnight.network/api/v4/graphql/ws",
      nodeUrl: "https://rpc.preview.midnight.network",
      proofServerUrl: "http://127.0.0.1:6300",
    });
  });

  it("resolves env-provided endpoints over the defaults (WS twin derived from the indexer URL)", () => {
    const config = getMidnightNodeConfig({
      NETWORK_ID: "preview",
      MIDNIGHT_NODE_URL: "https://node.example",
      MIDNIGHT_NODE_INDEXER_URL: "https://indexer.example/api/v4/graphql",
    });
    expect(config).toEqual({
      networkId: "preview",
      indexerUrl: "https://indexer.example/api/v4/graphql",
      indexerWsUrl: "wss://indexer.example/api/v4/graphql/ws",
      nodeUrl: "https://node.example",
      proofServerUrl: "http://127.0.0.1:6300",
    });
  });

  it("publishes the preview faucet URL, which MIDNIGHT_FAUCET_URL overrides", () => {
    expect(FAUCET_URLS.preview).toBe("https://midnight-tmnight-preview.nethermind.dev");
    expect(getFaucetUrl({}, "preview")).toBe("https://midnight-tmnight-preview.nethermind.dev");
    expect(getFaucetUrl({ MIDNIGHT_FAUCET_URL: "https://faucet.example" }, "preview")).toBe(
      "https://faucet.example",
    );
  });
});
