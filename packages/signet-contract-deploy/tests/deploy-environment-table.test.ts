// deployEnvironmentTable: env + resolved node config → the logged settings
// table. Pure — no network, no crypto.

import { describe, expect, it } from "vitest";

import {
  deployEnvironmentTable,
  deployerFundingLine,
  DeploySettingSource,
  getMidnightNodeConfig,
} from "../src/index.ts";

const SEED = "00000000000000000000000000000000000000000000000000000000000000aa";

describe("deployEnvironmentTable", () => {
  it("reports every built-in value as a default when the environment is empty", () => {
    const env = {};
    expect(deployEnvironmentTable(env, getMidnightNodeConfig(env))).toEqual({
      NETWORK_ID: { value: "undeployed", source: DeploySettingSource.Default },
      MIDNIGHT_NODE_URL: { value: "http://127.0.0.1:9944", source: DeploySettingSource.Default },
      MIDNIGHT_NODE_INDEXER_URL: {
        value: "http://127.0.0.1:8088/api/v4/graphql",
        source: DeploySettingSource.Default,
      },
      MIDNIGHT_NODE_INDEXER_WS_URL: {
        value: "ws://127.0.0.1:8088/api/v4/graphql/ws",
        source: DeploySettingSource.Default,
      },
      MIDNIGHT_NODE_PROOF_SERVER_URL: {
        value: "http://127.0.0.1:6300",
        source: DeploySettingSource.Default,
      },
      MIDNIGHT_FAUCET_URL: { value: "(none)", source: DeploySettingSource.Default },
    });
  });

  it("marks the variables the environment sets and leaves the seed out", () => {
    const env = {
      NETWORK_ID: "preview",
      MIDNIGHT_NODE_URL: "https://node.example",
      MIDNIGHT_NODE_PROOF_SERVER_URL: "   ",
      DEPLOYER_SEED: SEED,
    };
    const table = deployEnvironmentTable(env, getMidnightNodeConfig(env));
    expect(table).toEqual({
      NETWORK_ID: { value: "preview", source: DeploySettingSource.Environment },
      MIDNIGHT_NODE_URL: { value: "https://node.example", source: DeploySettingSource.Environment },
      MIDNIGHT_NODE_INDEXER_URL: {
        value: "https://indexer.preview.midnight.network/api/v4/graphql",
        source: DeploySettingSource.Default,
      },
      MIDNIGHT_NODE_INDEXER_WS_URL: {
        value: "wss://indexer.preview.midnight.network/api/v4/graphql/ws",
        source: DeploySettingSource.Default,
      },
      MIDNIGHT_NODE_PROOF_SERVER_URL: {
        value: "http://127.0.0.1:6300",
        source: DeploySettingSource.Default,
      },
      MIDNIGHT_FAUCET_URL: {
        value: "https://midnight-tmnight-preview.nethermind.dev",
        source: DeploySettingSource.Default,
      },
    });
    expect(JSON.stringify(table)).not.toContain(SEED);
  });

  it("masks the Blockfrost project token in every URL it reports", () => {
    const env = { NETWORK_ID: "preprod", BLOCKFROST_PROJECT_ID: "token" };
    const table = deployEnvironmentTable(env, getMidnightNodeConfig(env));
    expect(table.MIDNIGHT_NODE_URL?.value).toBe(
      "https://rpc.midnight-preprod.blockfrost.io/?project_id=REDACTED",
    );
    expect(table.MIDNIGHT_NODE_INDEXER_URL?.value).toBe(
      "https://midnight-preprod.blockfrost.io/api/v0?project_id=REDACTED",
    );
    expect(table.MIDNIGHT_NODE_INDEXER_WS_URL?.value).toBe(
      "wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=REDACTED",
    );
    expect(JSON.stringify(table)).not.toContain("token");
  });

  it("masks the query values of an overridden proof server and faucet URL", () => {
    const env = {
      MIDNIGHT_NODE_PROOF_SERVER_URL: "https://prover.example/?api_key=token",
      MIDNIGHT_FAUCET_URL: "https://faucet.example/?key=token",
    };
    const table = deployEnvironmentTable(env, getMidnightNodeConfig(env));
    expect(table.MIDNIGHT_NODE_PROOF_SERVER_URL?.value).toBe(
      "https://prover.example/?api_key=REDACTED",
    );
    expect(table.MIDNIGHT_FAUCET_URL?.value).toBe("https://faucet.example/?key=REDACTED");
  });
});

describe("deployerFundingLine", () => {
  interface Case {
    networkId: string;
    address: string;
  }
  const CASES: Case[] = [
    {
      networkId: "preview",
      address: "mn_addr_preview1zn4kwy7yhh03dancq9fde3ndn84c597hg8wculjawjwhe6zndqeqa8hm2l",
    },
    {
      networkId: "preprod",
      address: "mn_addr_preprod1zn4kwy7yhh03dancq9fde3ndn84c597hg8wculjawjwhe6zndqeqaxftez",
    },
    {
      networkId: "mainnet",
      address: "mn_addr1zn4kwy7yhh03dancq9fde3ndn84c597hg8wculjawjwhe6zndqeqxjae64",
    },
  ];

  it.each(CASES)("names the seed's NIGHT address on $networkId", ({ networkId, address }) => {
    expect(deployerFundingLine(SEED, networkId)).toBe(
      `deployer NIGHT address (fund this one): ${address}`,
    );
  });

  it("refuses a seed that is neither hex nor a mnemonic", () => {
    expect(() => deployerFundingLine("not a seed", "preview")).toThrow();
  });
});
