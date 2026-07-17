// Network identity + endpoint resolution. Pure — no network, no crypto.

import { describe, expect, it } from "vitest";

import {
  FAUCET_URLS,
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

describe("getMidnightNodeConfig for stagenet", () => {
  it("resolves the stagenet shielded.tools endpoints on the indexer v4 API", () => {
    const config = getMidnightNodeConfig({ NETWORK_ID: "stagenet" });
    expect(config).toEqual({
      networkId: "stagenet",
      indexerUrl: "https://indexer.stagenet.shielded.tools/api/v4/graphql",
      indexerWsUrl: "wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws",
      nodeUrl: "https://rpc.stagenet.shielded.tools",
      proofServerUrl: "http://127.0.0.1:6300",
    });
  });

  it("publishes a stagenet faucet URL for underfunded hints", () => {
    expect(FAUCET_URLS.stagenet).toBe("https://faucet.stagenet.shielded.tools");
  });
});
