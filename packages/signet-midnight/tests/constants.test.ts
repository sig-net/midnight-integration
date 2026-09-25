// Unit tests for the padded-ASCII codec and the published per-network
// counterparty values.

import { describe, expect, it } from "vitest";

import {
  asciiPadded,
  asciiUnpadded,
  type DeployedNetwork,
  getMpcOutputCacheUrl,
  getMpcRootPublicKey,
  getSignetContractAddress,
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

// The stagenet MPC root key as the MPC operators publish it (NEAR form): the
// constant must be that very key in the canonical spelling.
const STAGENET_MPC_ROOT_KEY_NEAR_FORM =
  "secp256k1:3Ww8iFjqTHufye5aRGUvrQqETegR4gVUcW8FX5xzscaN9ENhpkffojsxJwi6N1RbbHMTxYa9UyKeqK3fsMuwxjR5";
// The deployed networks whose counterparty values are not published yet.
const UNPUBLISHED_NETWORKS: readonly DeployedNetwork[] = [
  MidnightNetwork.Preview,
  MidnightNetwork.Preprod,
  MidnightNetwork.Mainnet,
];

describe("getMpcRootPublicKey", () => {
  it("publishes the stagenet key in canonical 0x04 uncompressed SEC1 hex", () => {
    const published = getMpcRootPublicKey(MidnightNetwork.Stagenet);
    expect(published).toMatch(/^0x04[0-9a-f]{128}$/);
    expect(published).toBe(normaliseSecp256k1PublicKey(STAGENET_MPC_ROOT_KEY_NEAR_FORM));
  });

  it.each(UNPUBLISHED_NETWORKS)("throws for %s, whose key is not published yet", (network) => {
    expect(() => getMpcRootPublicKey(network)).toThrow(/no MPC root public key published/);
  });
});

describe("getMpcOutputCacheUrl", () => {
  it("publishes the stagenet cache down to the MPC's object prefix", () => {
    expect(getMpcOutputCacheUrl(MidnightNetwork.Stagenet)).toBe(
      "https://storage.googleapis.com/midnight-cache-storage-testnet/v1/stagenet",
    );
  });

  it.each(UNPUBLISHED_NETWORKS)("throws for %s, whose cache is not published yet", (network) => {
    expect(() => getMpcOutputCacheUrl(network)).toThrow(/no MPC output cache URL/);
  });
});

describe("getSignetContractAddress", () => {
  it("publishes the stagenet singleton", () => {
    expect(getSignetContractAddress(MidnightNetwork.Stagenet)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(UNPUBLISHED_NETWORKS)(
    "throws for %s, whose singleton is not published yet",
    (network) => {
      expect(() => getSignetContractAddress(network)).toThrow(/no signet contract address/);
    },
  );
});
