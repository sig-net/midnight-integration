// Wallet generation: the mnemonic, its hex seed and the addresses per
// network. Pure crypto: no network.

import { describe, expect, it } from "vitest";

import {
  formatGeneratedWallet,
  generateWallet,
  parseWalletNetworks,
  walletFromMnemonic,
} from "../src/generate-wallet.ts";
import { MidnightNetwork } from "../src/plumbing/network-id.ts";
import { ParseError } from "../src/plumbing/seed.ts";
import { deriveAccountKeys, deriveAddresses } from "../src/plumbing/wallet.ts";

/** The all-zero-entropy BIP-39 test mnemonic, a public value. */
const MNEMONIC = `${"abandon ".repeat(23)}art`;

describe("walletFromMnemonic", () => {
  it("gives the mnemonic's 64-byte seed as hex, which derives the same addresses", () => {
    const wallet = walletFromMnemonic(MNEMONIC, [MidnightNetwork.Preprod]);
    expect(wallet.seedHex).toMatch(/^[0-9a-f]{128}$/);
    expect(wallet.addresses).toEqual([
      {
        networkId: MidnightNetwork.Preprod,
        addresses: deriveAddresses(
          deriveAccountKeys(wallet.seedHex, MidnightNetwork.Preprod),
          MidnightNetwork.Preprod,
        ),
      },
    ]);
  });

  it.each([
    {
      networkId: MidnightNetwork.Undeployed,
      unshielded: /^mn_addr_undeployed1/,
      shielded: /^mn_shield-addr_undeployed1/,
      dust: /^mn_dust_undeployed1/,
    },
    {
      networkId: MidnightNetwork.Preview,
      unshielded: /^mn_addr_preview1/,
      shielded: /^mn_shield-addr_preview1/,
      dust: /^mn_dust_preview1/,
    },
    {
      networkId: MidnightNetwork.Preprod,
      unshielded: /^mn_addr_preprod1/,
      shielded: /^mn_shield-addr_preprod1/,
      dust: /^mn_dust_preprod1/,
    },
    {
      networkId: MidnightNetwork.Mainnet,
      unshielded: /^mn_addr1/,
      shielded: /^mn_shield-addr1/,
      dust: /^mn_dust1/,
    },
  ])("encodes the addresses for $networkId", ({ networkId, unshielded, shielded, dust }) => {
    const [entry] = walletFromMnemonic(MNEMONIC, [networkId]).addresses;
    expect(entry?.addresses.unshielded).toMatch(unshielded);
    expect(entry?.addresses.shielded).toMatch(shielded);
    expect(entry?.addresses.dust).toMatch(dust);
  });

  it("writes the mnemonic with single spaces", () => {
    expect(walletFromMnemonic(`  ${MNEMONIC.replaceAll(" ", "  ")} `, []).mnemonic).toBe(MNEMONIC);
  });

  it("refuses a hex seed", () => {
    expect(() => walletFromMnemonic("01".repeat(32), [])).toThrow(ParseError);
  });
});

describe("generateWallet", () => {
  it("generates a different 24-word mnemonic each time", () => {
    const first = generateWallet([]);
    const second = generateWallet([]);
    expect(first.mnemonic.split(" ")).toHaveLength(24);
    expect(second.mnemonic).not.toBe(first.mnemonic);
  });
});

describe("formatGeneratedWallet", () => {
  it("writes the seed words, the seed hex and each network's addresses", () => {
    expect(
      formatGeneratedWallet({
        mnemonic: "one two three",
        seedHex: "abcd",
        addresses: [
          {
            networkId: MidnightNetwork.Preprod,
            addresses: { unshielded: "mn_addr_x", shielded: "mn_shield-addr_y", dust: "mn_dust_z" },
          },
        ],
      }),
    ).toBe(
      [
        "Seed Words: one two three",
        "Seed Hex: abcd",
        "",
        "Addresses on preprod:",
        "  Unshielded (NIGHT): mn_addr_x",
        "  Shielded: mn_shield-addr_y",
        "  Dust: mn_dust_z",
      ].join("\n"),
    );
  });
});

describe("parseWalletNetworks", () => {
  it("names every network when none is given", () => {
    expect(parseWalletNetworks([])).toEqual(["undeployed", "preview", "preprod", "mainnet"]);
  });

  it("keeps the named networks in the order given", () => {
    expect(parseWalletNetworks(["mainnet", "preprod"])).toEqual(["mainnet", "preprod"]);
  });

  it("refuses a name that is not a network id", () => {
    expect(() => parseWalletNetworks(["preprod", "stagenet"])).toThrow(
      'Unknown network "stagenet": expected one of undeployed, preview, preprod, mainnet.',
    );
  });
});
