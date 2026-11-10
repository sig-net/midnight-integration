// Unit tests for the padded-ASCII codec and the published per-network
// counterparty values.

import { describe, expect, it } from "vitest";

import {
  asciiPadded,
  asciiUnpadded,
  type DeployedNetwork,
  getMpcOutputCacheUrl,
  getMpcRootPublicKey,
  getResponderContractAddress,
  getSignerContractAddress,
  MidnightNetwork,
  normaliseSecp256k1PublicKey,
} from "../src/index.ts";

describe("asciiPadded", () => {
  interface Case {
    name: string;
    text: string;
    length: number;
    expectedPrefix: number[];
  }

  const CASES: Case[] = [
    {
      name: "algo value",
      text: "ecdsa",
      length: 32,
      expectedPrefix: [0x65, 0x63, 0x64, 0x73, 0x61, 0, 0],
    },
    { name: "empty text", text: "", length: 4, expectedPrefix: [0, 0, 0, 0] },
    { name: "exact fit", text: "ab", length: 2, expectedPrefix: [0x61, 0x62] },
  ];

  it.each(CASES)("$name: zero-padded to the field width", ({ text, length, expectedPrefix }) => {
    const encoded = asciiPadded(text, length);
    expect(encoded.length).toBe(length);
    expect([...encoded.slice(0, expectedPrefix.length)]).toEqual(expectedPrefix);
    expect(encoded.slice(text.length).every((byte) => byte === 0)).toBe(true);
  });

  it("rejects text longer than the field", () => {
    expect(() => asciiPadded("too long", 4)).toThrow(/does not fit/);
  });
});

describe("asciiUnpadded", () => {
  interface Case {
    name: string;
    bytes: Uint8Array;
    expected: string;
  }

  const CASES: Case[] = [
    {
      name: "a padded field loses its padding",
      bytes: asciiPadded("eip155:1", 32),
      expected: "eip155:1",
    },
    {
      name: "text filling the whole field is returned whole",
      bytes: asciiPadded("x".repeat(32), 32),
      expected: "x".repeat(32),
    },
    {
      name: "a zero byte inside the text is kept",
      bytes: Uint8Array.from([0x61, 0x00, 0x62, 0x00, 0x00]),
      expected: "a\u0000b",
    },
    {
      name: "an all-zero field is the empty text",
      bytes: new Uint8Array(32),
      expected: "",
    },
  ];

  it.each(CASES)("$name", ({ bytes, expected }) => {
    expect(asciiUnpadded(bytes)).toBe(expected);
  });
});

// The preview MPC root key as the MPC operators publish it (NEAR form), the
// signet.js TESTNET_DEV key.
const PREVIEW_MPC_ROOT_KEY_NEAR_FORM =
  "secp256k1:54hU5wcCmVUPFWLDALXMh1fFToZsVXrx9BbTbHzSfQq1Kd1rJZi52iPa4QQxo6s5TgjWqgpY8HamYuUDzG6fAaUq";
// The deployed networks with no MPC root key published yet.
const NETWORKS_WITHOUT_MPC_ROOT_KEY: readonly DeployedNetwork[] = [
  MidnightNetwork.Preprod,
  MidnightNetwork.Mainnet,
];
// The deployed networks with no MPC output cache published yet.
const NETWORKS_WITHOUT_OUTPUT_CACHE: readonly DeployedNetwork[] = [
  MidnightNetwork.Preprod,
  MidnightNetwork.Mainnet,
];

describe("getMpcRootPublicKey", () => {
  it("publishes the preview key in canonical 0x04 uncompressed SEC1 hex", () => {
    const published = getMpcRootPublicKey(MidnightNetwork.Preview);
    expect(published).toMatch(/^0x04[0-9a-f]{128}$/);
    expect(published).toBe(normaliseSecp256k1PublicKey(PREVIEW_MPC_ROOT_KEY_NEAR_FORM));
  });

  it.each(NETWORKS_WITHOUT_MPC_ROOT_KEY)(
    "throws for %s, whose key is not published yet",
    (network) => {
      expect(() => getMpcRootPublicKey(network)).toThrow(/no MPC root public key published/);
    },
  );
});

describe("getMpcOutputCacheUrl", () => {
  it("publishes the preview cache down to the dev MPC's object prefix", () => {
    expect(getMpcOutputCacheUrl(MidnightNetwork.Preview)).toBe(
      "https://storage.googleapis.com/midnight-cache-storage-dev/v1/stagenet",
    );
  });

  it.each(NETWORKS_WITHOUT_OUTPUT_CACHE)(
    "throws for %s, whose cache is not published yet",
    (network) => {
      expect(() => getMpcOutputCacheUrl(network)).toThrow(/no MPC output cache URL/);
    },
  );
});

describe("getSignerContractAddress", () => {
  const NETWORKS_WITH_SIGNER: readonly DeployedNetwork[] = [
    MidnightNetwork.Preview,
    MidnightNetwork.Preprod,
  ];
  const NETWORKS_WITHOUT_SIGNER: readonly DeployedNetwork[] = [MidnightNetwork.Mainnet];

  it.each(NETWORKS_WITH_SIGNER)("publishes the %s signet signer", (network) => {
    expect(getSignerContractAddress(network)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(NETWORKS_WITHOUT_SIGNER)(
    "throws for %s, which has no published signet signer",
    (network) => {
      expect(() => getSignerContractAddress(network)).toThrow(/no signet signer address/);
    },
  );
});

describe("getResponderContractAddress", () => {
  const NETWORKS_WITHOUT_RESPONDER: readonly DeployedNetwork[] = [
    MidnightNetwork.Preprod,
    MidnightNetwork.Mainnet,
  ];

  it("publishes the preview responder", () => {
    expect(getResponderContractAddress(MidnightNetwork.Preview)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(NETWORKS_WITHOUT_RESPONDER)(
    "throws for %s, which has no published responder",
    (network) => {
      expect(() => getResponderContractAddress(network)).toThrow(
        /no responder contract address published for the '[a-z]+' network yet/,
      );
    },
  );
});
