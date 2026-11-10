// Unit tests for the constants.ts table surgery behind the
// record-contract-address entrypoint: the contract and network gates, the
// scoped row rewrite, and its lockstep with the real constants.ts source.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { contractAddressFromHex, type DeployedNetwork, MidnightNetwork } from "../src/index.ts";
import {
  parseDeployedNetwork,
  parsePublishedContract,
  PublishedContract,
  recordContractAddress,
} from "../src/record-contract-address.ts";

const ADDRESS_HEX = "1df4ce25fc9f9c03dc6f4d0eb12ddf3d0db094995d4c70aca1142eebb3b77a5d";
const ADDRESS = contractAddressFromHex(ADDRESS_HEX);
const EXISTING_HEX = "ab".repeat(32);
// Recorded into the real constants.ts below, so it must be one no network's
// row can already hold: a pattern no deploy produces.
const UNRECORDED_HEX = "5e".repeat(32);
const UNRECORDED = contractAddressFromHex(UNRECORDED_HEX);

describe("parseDeployedNetwork", () => {
  it.each([
    ["stagenet", MidnightNetwork.Stagenet],
    ["preview", MidnightNetwork.Preview],
    ["preprod", MidnightNetwork.Preprod],
    ["mainnet", MidnightNetwork.Mainnet],
  ])("accepts %s", (networkId, expected) => {
    expect(parseDeployedNetwork(networkId)).toBe(expected);
  });

  it.each([
    ["the local standalone stack", "undeployed"],
    ["an unknown id", "nope"],
    ["a member name instead of an id", "Stagenet"],
  ])("rejects %s", (_name, networkId) => {
    expect(() => parseDeployedNetwork(networkId)).toThrow(
      /expected one of stagenet, preview, preprod, mainnet/,
    );
  });
});

describe("parsePublishedContract", () => {
  it.each([
    ["signet-contract", PublishedContract.SignetContract],
    ["signet-responder", PublishedContract.SignetResponder],
  ])("accepts %s", (name, expected) => {
    expect(parsePublishedContract(name)).toBe(expected);
  });

  it.each([
    ["an unpublished contract", "test-caller-contract"],
    ["a member name instead of a name", "SignetResponder"],
  ])("rejects %s", (_name, name) => {
    expect(() => parsePublishedContract(name)).toThrow(
      /expected one of signet-contract, signet-responder/,
    );
  });
});

describe("recordContractAddress", () => {
  // A cut-down constants.ts: a table keyed by the same members, then both
  // address tables, the singleton's with one row already filled.
  const ROOT_KEYS_TABLE = `const mpcRootPublicKeys: Record<DeployedNetwork, string> = {
  [MidnightNetwork.Stagenet]: "",
  [MidnightNetwork.Preview]: "",
  [MidnightNetwork.Preprod]: "",
  [MidnightNetwork.Mainnet]: "",
};
`;
  const ADDRESS_TABLE = `const signetContractAddresses: Record<DeployedNetwork, string> = {
  [MidnightNetwork.Stagenet]: "",
  [MidnightNetwork.Preview]: "${EXISTING_HEX}",
  [MidnightNetwork.Preprod]: "",
  [MidnightNetwork.Mainnet]: "",
};
`;
  const RESPONDER_TABLE = `const responderContractAddresses: Record<DeployedNetwork, string> = {
  [MidnightNetwork.Stagenet]: "",
  [MidnightNetwork.Preview]: "",
  [MidnightNetwork.Preprod]: "",
  [MidnightNetwork.Mainnet]: "",
};
`;
  const SOURCE = ROOT_KEYS_TABLE + "\n" + ADDRESS_TABLE + "\n" + RESPONDER_TABLE;

  interface Case {
    name: string;
    contract: PublishedContract;
    network: MidnightNetwork.Stagenet | MidnightNetwork.Preview;
    previousEntry: string;
    entry: string;
    /** The whole source after the rewrite. */
    expectedSource: string;
  }

  const CASES: Case[] = [
    {
      name: "fills an empty singleton row",
      contract: PublishedContract.SignetContract,
      network: MidnightNetwork.Stagenet,
      previousEntry: '[MidnightNetwork.Stagenet]: ""',
      entry: `[MidnightNetwork.Stagenet]: "${ADDRESS_HEX}"`,
      expectedSource:
        ROOT_KEYS_TABLE +
        "\n" +
        ADDRESS_TABLE.replace(
          '[MidnightNetwork.Stagenet]: ""',
          `[MidnightNetwork.Stagenet]: "${ADDRESS_HEX}"`,
        ) +
        "\n" +
        RESPONDER_TABLE,
    },
    {
      name: "replaces a filled singleton row",
      contract: PublishedContract.SignetContract,
      network: MidnightNetwork.Preview,
      previousEntry: `[MidnightNetwork.Preview]: "${EXISTING_HEX}"`,
      entry: `[MidnightNetwork.Preview]: "${ADDRESS_HEX}"`,
      expectedSource:
        ROOT_KEYS_TABLE +
        "\n" +
        ADDRESS_TABLE.replace(EXISTING_HEX, ADDRESS_HEX) +
        "\n" +
        RESPONDER_TABLE,
    },
    {
      name: "fills a responder row",
      contract: PublishedContract.SignetResponder,
      network: MidnightNetwork.Preview,
      previousEntry: '[MidnightNetwork.Preview]: ""',
      entry: `[MidnightNetwork.Preview]: "${ADDRESS_HEX}"`,
      expectedSource:
        ROOT_KEYS_TABLE +
        "\n" +
        ADDRESS_TABLE +
        "\n" +
        RESPONDER_TABLE.replace(
          '[MidnightNetwork.Preview]: ""',
          `[MidnightNetwork.Preview]: "${ADDRESS_HEX}"`,
        ),
    },
  ];

  it.each(CASES)(
    "$name, touching nothing else",
    ({ contract, network, previousEntry, entry, expectedSource }) => {
      const recorded = recordContractAddress(SOURCE, contract, network, ADDRESS);
      expect(recorded.previousEntry).toBe(previousEntry);
      expect(recorded.entry).toBe(entry);
      expect(recorded.source).toBe(expectedSource);
    },
  );

  it("normalises a 0x-prefixed uppercase address to bare lowercase hex", () => {
    const address = contractAddressFromHex(`0x${ADDRESS_HEX.toUpperCase()}`);
    expect(
      recordContractAddress(
        SOURCE,
        PublishedContract.SignetContract,
        MidnightNetwork.Stagenet,
        address,
      ).entry,
    ).toBe(`[MidnightNetwork.Stagenet]: "${ADDRESS_HEX}"`);
  });

  interface ThrowCase {
    name: string;
    source: string;
    expectedMessage: RegExp;
  }

  const THROW_CASES: ThrowCase[] = [
    {
      name: "no address table",
      source: ROOT_KEYS_TABLE,
      expectedMessage: /no "signetContractAddresses" table/,
    },
    {
      name: "an unclosed address table",
      source: ROOT_KEYS_TABLE + "\n" + ADDRESS_TABLE.replace("\n};", ""),
      expectedMessage: /not closed/,
    },
    {
      name: "a table without the network's row",
      source:
        ROOT_KEYS_TABLE + "\n" + ADDRESS_TABLE.replace('[MidnightNetwork.Stagenet]: "",\n', ""),
      expectedMessage: /expected exactly one stagenet row in signetContractAddresses, found 0/,
    },
    {
      name: "a table with the network's row twice",
      source:
        ROOT_KEYS_TABLE +
        "\n" +
        ADDRESS_TABLE.replace('""', '"",\n  [MidnightNetwork.Stagenet]: ""'),
      expectedMessage: /expected exactly one stagenet row in signetContractAddresses, found 2/,
    },
  ];

  it.each(THROW_CASES)("throws on $name", ({ source, expectedMessage }) => {
    expect(() =>
      recordContractAddress(
        source,
        PublishedContract.SignetContract,
        MidnightNetwork.Stagenet,
        ADDRESS,
      ),
    ).toThrow(expectedMessage);
  });

  // Lockstep with the file the entrypoint edits: the fixture above mirrors its
  // shape, and this pins the real source to the same shape.
  it.each(Object.values(PublishedContract))(
    "rewrites every deployed network's %s row of the real constants.ts",
    (contract) => {
      const real = readFileSync(new URL("../src/constants.ts", import.meta.url), "utf8");
      expect(real).not.toContain(UNRECORDED_HEX);
      const rootKeysTable = real.slice(
        real.indexOf("const mpcRootPublicKeys"),
        real.indexOf("const signetContractAddresses"),
      );
      const networks: DeployedNetwork[] = [
        MidnightNetwork.Stagenet,
        MidnightNetwork.Preview,
        MidnightNetwork.Preprod,
        MidnightNetwork.Mainnet,
      ];
      for (const network of networks) {
        const recorded = recordContractAddress(real, contract, network, UNRECORDED);
        expect(recorded.source).toContain(recorded.entry);
        expect(recorded.source.split(UNRECORDED_HEX)).toHaveLength(2);
        expect(recorded.source).toContain(rootKeysTable);
      }
    },
  );
});
