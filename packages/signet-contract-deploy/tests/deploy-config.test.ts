// getDeployConfig: env → DeployConfig parsing. Pure — no network, no crypto.

import { describe, expect, it } from "vitest";

import {
  type DeployerWalletConfig,
  DeployerWalletKind,
  getDeployConfig,
  type NetworkId,
} from "../src/index.ts";

// The pre-funded genesis mint wallet of the local standalone stack — the
// documented default when DEPLOYER_SEED is unset.
const GENESIS_MINT_WALLET_SEED = "0000000000000000000000000000000000000000000000000000000000000001";

const CUSTOM_SEED = "00000000000000000000000000000000000000000000000000000000000000aa";

// Stagenet's endpoints are deliberately not published in the repo, so the
// environment must supply them before getDeployConfig's node-config read
// resolves (see network.test.ts for that requirement itself).
const STAGENET_ENDPOINTS = {
  MIDNIGHT_NODE_URL: "https://node.example",
  MIDNIGHT_NODE_INDEXER_URL: "https://indexer.example/api/v4/graphql",
};

const REMOTE_WALLET_URL = "https://wallet-host.example/wallet/v1/";

interface Case {
  name: string;
  env: Record<string, string | undefined>;
  expectedDeployerWallet: DeployerWalletConfig;
  expectedNetworkId: NetworkId;
}

const CASES: Case[] = [
  {
    name: "empty env → genesis mint seed on undeployed",
    env: {},
    expectedDeployerWallet: { kind: DeployerWalletKind.Seed, seed: GENESIS_MINT_WALLET_SEED },
    expectedNetworkId: "undeployed",
  },
  {
    name: "DEPLOYER_SEED is used and trimmed",
    env: { DEPLOYER_SEED: `  ${CUSTOM_SEED}  ` },
    expectedDeployerWallet: { kind: DeployerWalletKind.Seed, seed: CUSTOM_SEED },
    expectedNetworkId: "undeployed",
  },
  {
    name: "whitespace-only DEPLOYER_SEED falls back to the genesis mint seed",
    env: { DEPLOYER_SEED: "   " },
    expectedDeployerWallet: { kind: DeployerWalletKind.Seed, seed: GENESIS_MINT_WALLET_SEED },
    expectedNetworkId: "undeployed",
  },
  {
    name: "NETWORK_ID flows through to the node config",
    env: { NETWORK_ID: "preview", DEPLOYER_SEED: CUSTOM_SEED },
    expectedDeployerWallet: { kind: DeployerWalletKind.Seed, seed: CUSTOM_SEED },
    expectedNetworkId: "preview",
  },
  {
    name: "a deployed network uses the provided DEPLOYER_SEED",
    env: { NETWORK_ID: "stagenet", DEPLOYER_SEED: CUSTOM_SEED, ...STAGENET_ENDPOINTS },
    expectedDeployerWallet: { kind: DeployerWalletKind.Seed, seed: CUSTOM_SEED },
    expectedNetworkId: "stagenet",
  },
  {
    name: "DEPLOYER_REMOTE_WALLET_URL selects a remote deployer wallet",
    env: { DEPLOYER_REMOTE_WALLET_URL: REMOTE_WALLET_URL },
    expectedDeployerWallet: { kind: DeployerWalletKind.Remote, url: new URL(REMOTE_WALLET_URL) },
    expectedNetworkId: "undeployed",
  },
  {
    name: "a deployed network accepts a remote deployer wallet with no seed",
    env: {
      NETWORK_ID: "stagenet",
      DEPLOYER_REMOTE_WALLET_URL: REMOTE_WALLET_URL,
      ...STAGENET_ENDPOINTS,
    },
    expectedDeployerWallet: { kind: DeployerWalletKind.Remote, url: new URL(REMOTE_WALLET_URL) },
    expectedNetworkId: "stagenet",
  },
  {
    name: "a whitespace-only DEPLOYER_REMOTE_WALLET_URL counts as unset",
    env: { DEPLOYER_REMOTE_WALLET_URL: "   ", DEPLOYER_SEED: CUSTOM_SEED },
    expectedDeployerWallet: { kind: DeployerWalletKind.Seed, seed: CUSTOM_SEED },
    expectedNetworkId: "undeployed",
  },
];

describe("getDeployConfig", () => {
  it.each(CASES)("$name", ({ env, expectedDeployerWallet, expectedNetworkId }) => {
    const config = getDeployConfig(env);
    expect(config.deployerWallet).toEqual(expectedDeployerWallet);
    expect(config.midnightNodeConfig.networkId).toBe(expectedNetworkId);
  });
});

// Rejections: the deployer wallet source must be exactly one of the two
// variables, and on a deployed network the genesis mint wallet is unfunded,
// so a funded DEPLOYER_SEED (or a remote wallet) is mandatory there.
interface ThrowCase {
  name: string;
  env: Record<string, string | undefined>;
  expectedMessage: RegExp;
}

const THROW_CASES: ThrowCase[] = [
  {
    name: "both DEPLOYER_SEED and DEPLOYER_REMOTE_WALLET_URL is refused",
    env: { DEPLOYER_SEED: CUSTOM_SEED, DEPLOYER_REMOTE_WALLET_URL: REMOTE_WALLET_URL },
    expectedMessage: /exactly one of DEPLOYER_SEED and DEPLOYER_REMOTE_WALLET_URL/,
  },
  {
    name: "a malformed DEPLOYER_REMOTE_WALLET_URL is refused",
    env: { DEPLOYER_REMOTE_WALLET_URL: "not a url" },
    expectedMessage: /DEPLOYER_REMOTE_WALLET_URL is not a valid URL/,
  },
  {
    name: "deployed network without DEPLOYER_SEED demands one",
    env: { NETWORK_ID: "stagenet", ...STAGENET_ENDPOINTS },
    expectedMessage: /DEPLOYER_SEED is required on "stagenet"/,
  },
  {
    name: "deployed network with a whitespace DEPLOYER_SEED demands one",
    env: { NETWORK_ID: "preprod", DEPLOYER_SEED: "   " },
    expectedMessage: /DEPLOYER_SEED is required on "preprod"/,
  },
  {
    name: "deployed network rejects the (unfunded here) genesis mint seed",
    env: { NETWORK_ID: "stagenet", DEPLOYER_SEED: GENESIS_MINT_WALLET_SEED, ...STAGENET_ENDPOINTS },
    expectedMessage: /genesis mint seed, which holds no funds on "stagenet"/,
  },
  {
    name: "an env-provided MIDNIGHT_FAUCET_URL appears in the funding hint",
    env: {
      NETWORK_ID: "stagenet",
      MIDNIGHT_FAUCET_URL: "https://faucet.example",
      ...STAGENET_ENDPOINTS,
    },
    expectedMessage: /faucet\.example/,
  },
];

describe("getDeployConfig on deployed networks", () => {
  it.each(THROW_CASES)("$name", ({ env, expectedMessage }) => {
    expect(() => getDeployConfig(env)).toThrow(expectedMessage);
  });
});
