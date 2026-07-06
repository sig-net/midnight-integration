// getCliConfig: env → CliConfig parsing. Pure — no network, no contracts.

import { describe, expect, it } from "vitest";

import { getCliConfig, requireConfigValue, type CliConfig } from "../src/config.ts";

// The pre-funded genesis mint wallet of the local standalone stack — the
// documented default when USER_SEED is unset.
const GENESIS_MINT_WALLET_SEED = "0000000000000000000000000000000000000000000000000000000000000001";

const CUSTOM_SEED = "00000000000000000000000000000000000000000000000000000000000000aa";
const CUSTOM_SECRET = "00000000000000000000000000000000000000000000000000000000000000bb";
const ERC20_ADDRESS = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

const bytesOf = (hex: string) => Uint8Array.from(hex.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)));

interface Case {
  name: string;
  env: Record<string, string | undefined>;
  expected: Omit<CliConfig, "midnightNodeConfig">;
}

const CASES: Case[] = [
  {
    name: "empty env → genesis seed doubling as the identity, nothing else set",
    env: {},
    expected: {
      userSeed: GENESIS_MINT_WALLET_SEED,
      userSecretKey: bytesOf(GENESIS_MINT_WALLET_SEED),
      vaultContractAddress: undefined,
      signetContractAddress: undefined,
      evmRpcUrl: undefined,
      evmChainId: undefined,
      caip2Id: undefined,
      erc20Address: undefined,
    },
  },
  {
    name: "fully configured env is parsed and passed through",
    env: {
      USER_SEED: CUSTOM_SEED,
      VAULT_USER_SECRET_KEY: `0x${CUSTOM_SECRET}`,
      MIDNIGHT_VAULT_CONTRACT_ADDRESS: "0200aabb",
      SIGNET_CONTRACT_ADDRESS: "0200ccdd",
      EVM_RPC_URL: "https://sepolia.example/rpc",
      EVM_CHAIN_ID: "11155111",
      ERC20_ADDRESS,
    },
    expected: {
      userSeed: CUSTOM_SEED,
      userSecretKey: bytesOf(CUSTOM_SECRET),
      vaultContractAddress: "0200aabb",
      signetContractAddress: "0200ccdd",
      evmRpcUrl: "https://sepolia.example/rpc",
      evmChainId: 11155111n,
      caip2Id: "eip155:11155111",
      erc20Address: ERC20_ADDRESS,
    },
  },
  {
    name: "whitespace-only optionals are treated as unset",
    env: {
      MIDNIGHT_VAULT_CONTRACT_ADDRESS: "   ",
      SIGNET_CONTRACT_ADDRESS: "   ",
      EVM_RPC_URL: "   ",
      EVM_CHAIN_ID: "   ",
      ERC20_ADDRESS: "   ",
    },
    expected: {
      userSeed: GENESIS_MINT_WALLET_SEED,
      userSecretKey: bytesOf(GENESIS_MINT_WALLET_SEED),
      vaultContractAddress: undefined,
      signetContractAddress: undefined,
      evmRpcUrl: undefined,
      evmChainId: undefined,
      caip2Id: undefined,
      erc20Address: undefined,
    },
  },
];

describe("getCliConfig", () => {
  it.each(CASES)("$name", ({ env, expected }) => {
    const { midnightNodeConfig, ...rest } = getCliConfig(env);
    expect(rest).toEqual(expected);
    expect(midnightNodeConfig.networkId).toBe("undeployed");
  });

  it("rejects a non-numeric EVM_CHAIN_ID", () => {
    expect(() => getCliConfig({ EVM_CHAIN_ID: "sepolia" })).toThrow(/EVM_CHAIN_ID/);
  });

  it("rejects a malformed ERC20_ADDRESS", () => {
    expect(() => getCliConfig({ ERC20_ADDRESS: "0x1234" })).toThrow(/ERC20_ADDRESS/);
  });
});

describe("requireConfigValue", () => {
  it("returns a present value unchanged", () => {
    expect(requireConfigValue("0200aabb", "MIDNIGHT_VAULT_CONTRACT_ADDRESS")).toBe("0200aabb");
  });

  it("fails on an absent value, naming the env var to set", () => {
    expect(() => requireConfigValue(undefined, "MIDNIGHT_VAULT_CONTRACT_ADDRESS")).toThrow(/MIDNIGHT_VAULT_CONTRACT_ADDRESS/);
  });
});
