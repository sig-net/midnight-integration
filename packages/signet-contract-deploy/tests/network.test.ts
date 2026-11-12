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

describe("getMidnightNodeConfig for the Blockfrost-served networks", () => {
  interface BlockfrostCase {
    networkId: NetworkId;
    host: string;
  }
  const BLOCKFROST_CASES: BlockfrostCase[] = [
    { networkId: "preprod", host: "midnight-preprod.blockfrost.io" },
    { networkId: "mainnet", host: "midnight-mainnet.blockfrost.io" },
  ];

  it.each(BLOCKFROST_CASES)(
    "puts BLOCKFROST_PROJECT_ID on every $networkId endpoint",
    ({ networkId, host }) => {
      expect(
        getMidnightNodeConfig({ NETWORK_ID: networkId, BLOCKFROST_PROJECT_ID: "token" }),
      ).toEqual({
        networkId,
        indexerUrl: `https://${host}/api/v0?project_id=token`,
        indexerWsUrl: `wss://${host}/api/v0/ws?project_id=token`,
        nodeUrl: `https://rpc.${host}?project_id=token`,
        proofServerUrl: "http://127.0.0.1:6300",
      });
    },
  );

  it.each(BLOCKFROST_CASES)(
    "reaches a self-hosted $networkId node and indexer without a token",
    ({ networkId }) => {
      expect(
        getMidnightNodeConfig({
          NETWORK_ID: networkId,
          MIDNIGHT_NODE_URL: "https://node.example",
          MIDNIGHT_NODE_INDEXER_URL: "https://indexer.example/api/v4/graphql",
        }),
      ).toEqual({
        networkId,
        indexerUrl: "https://indexer.example/api/v4/graphql",
        indexerWsUrl: "wss://indexer.example/api/v4/graphql/ws",
        nodeUrl: "https://node.example",
        proofServerUrl: "http://127.0.0.1:6300",
      });
    },
  );

  it.each(BLOCKFROST_CASES)(
    "keeps a token on the WS twin derived from a $networkId indexer override",
    ({ networkId, host }) => {
      const config = getMidnightNodeConfig({
        NETWORK_ID: networkId,
        MIDNIGHT_NODE_URL: `https://rpc.${host}?project_id=token`,
        MIDNIGHT_NODE_INDEXER_URL: `https://${host}/api/v0?project_id=token`,
      });
      expect(config.indexerWsUrl).toBe(`wss://${host}/api/v0/ws?project_id=token`);
    },
  );

  interface UnreachableCase {
    name: string;
    env: Record<string, string>;
  }
  const UNREACHABLE_CASES: UnreachableCase[] = [
    { name: "preprod with nothing set", env: { NETWORK_ID: "preprod" } },
    { name: "mainnet with nothing set", env: { NETWORK_ID: "mainnet" } },
    {
      name: "preprod with a blank token",
      env: { NETWORK_ID: "preprod", BLOCKFROST_PROJECT_ID: "   " },
    },
    {
      name: "preprod with only the node URL",
      env: { NETWORK_ID: "preprod", MIDNIGHT_NODE_URL: "https://node.example" },
    },
    {
      name: "mainnet with only the indexer URL",
      env: { NETWORK_ID: "mainnet", MIDNIGHT_NODE_INDEXER_URL: "https://indexer.example" },
    },
  ];

  it.each(UNREACHABLE_CASES)("refuses $name, naming the token variable", ({ env }) => {
    expect(() => getMidnightNodeConfig(env)).toThrow(
      /served by Blockfrost: set BLOCKFROST_PROJECT_ID .* or set both MIDNIGHT_NODE_URL and MIDNIGHT_NODE_INDEXER_URL/,
    );
  });
});
