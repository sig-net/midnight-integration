// parseIdentitySecretKey: env → 32-byte identity secret. Pure — no network.

import { describe, expect, it } from "vitest";

import { ParseError, generateMnemonic, parseIdentitySecretKey } from "../src/index.ts";

const ENV_VAR = "USER_SECRET_KEY";

const SECRET_HEX = "00000000000000000000000000000000000000000000000000000000000000aa";
const SEED_HEX = "0000000000000000000000000000000000000000000000000000000000000001";

const bytesOf = (hex: string) => Uint8Array.from(hex.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)));

interface Case {
  name: string;
  env: Record<string, string | undefined>;
  fallbackSeed: string;
  expected: Uint8Array;
}

const CASES: Case[] = [
  {
    name: "env var set (plain hex) wins over the fallback seed",
    env: { [ENV_VAR]: SECRET_HEX },
    fallbackSeed: SEED_HEX,
    expected: bytesOf(SECRET_HEX),
  },
  {
    name: "env var set with 0x prefix and padding is normalised",
    env: { [ENV_VAR]: `  0x${SECRET_HEX}  ` },
    fallbackSeed: SEED_HEX,
    expected: bytesOf(SECRET_HEX),
  },
  {
    name: "env var unset → the 32-byte fallback seed IS the identity",
    env: {},
    fallbackSeed: SEED_HEX,
    expected: bytesOf(SEED_HEX),
  },
  {
    name: "whitespace-only env var falls back to the seed",
    env: { [ENV_VAR]: "   " },
    fallbackSeed: SEED_HEX,
    expected: bytesOf(SEED_HEX),
  },
];

describe("parseIdentitySecretKey", () => {
  it.each(CASES)("$name", ({ env, fallbackSeed, expected }) => {
    expect(parseIdentitySecretKey(ENV_VAR, env, fallbackSeed)).toEqual(expected);
  });

  it("rejects an env var that is not 32 bytes of hex, naming the variable", () => {
    expect(() => parseIdentitySecretKey(ENV_VAR, { [ENV_VAR]: "0xabcd" }, SEED_HEX)).toThrow(
      new ParseError(`${ENV_VAR} must be exactly 32 bytes of hex`),
    );
  });

  it("rejects a fallback seed that does not parse to exactly 32 bytes", () => {
    // A mnemonic derives a 64-byte seed, so it cannot double as the identity.
    expect(() => parseIdentitySecretKey(ENV_VAR, {}, generateMnemonic())).toThrow(ParseError);
  });
});
