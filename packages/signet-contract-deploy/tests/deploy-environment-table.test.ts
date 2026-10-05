// deployEnvironmentTable: env + resolved node config → the logged settings
// table. Pure — no network, no crypto.

import { describe, expect, it } from "vitest";

import {
  deployEnvironmentTable,
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
});
