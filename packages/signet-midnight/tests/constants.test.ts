// Unit tests for the padded-ASCII codec, the MPC failure sentinel and the
// published per-network counterparty values.

import { describe, expect, it } from "vitest";

import {
  asciiPadded,
  asciiUnpadded,
  type DeployedNetwork,
  getMpcOutputCacheUrl,
  getMpcRootPublicKey,
  getSignetContractAddress,
  isMpcFailureOutput,
  MidnightNetwork,
  MPC_FAILURE_OUTPUT,
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

// The failure output is a wire constant shared by the responder and every
// client's refund circuit: pin its exact bytes.
describe("MPC_FAILURE_OUTPUT", () => {
  it("is the 4-byte error marker followed by a single 0x01 byte", () => {
    expect(MPC_FAILURE_OUTPUT).toEqual(Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x01]));
  });
});

/** One row of the serializedOutput decode table: bytes → expected verdict. */
interface DecodeCase {
  /** Test name, completing the sentence "decodes <name>". */
  name: string;
  /** The response's serialized output. */
  serializedOutput: Uint8Array;
  /** Expected {@link isMpcFailureOutput} verdict. */
  failure: boolean;
}

// Outputs are the exact unpadded respond payloads (a packed bool is one
// byte). Only exact byte equality with the 5-byte failure payload counts as
// the MPC failure: prefixes and extensions are legitimate packed outputs.
const DECODE_CASES: DecodeCase[] = [
  {
    name: "a one-byte packed bool (0x01)",
    serializedOutput: Uint8Array.from([1]),
    failure: false,
  },
  {
    name: "a one-byte packed bool (0x00)",
    serializedOutput: Uint8Array.from([0]),
    failure: false,
  },
  {
    name: "the exact 5-byte failure payload",
    serializedOutput: MPC_FAILURE_OUTPUT,
    failure: true,
  },
  {
    name: "a 4-byte deadbeef prefix with a different fifth byte",
    serializedOutput: Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x02]),
    failure: false,
  },
  {
    name: "the bare 4-byte deadbeef marker without the 0x01 byte",
    serializedOutput: Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
    failure: false,
  },
  {
    name: "a 6-byte output that merely starts with the failure payload",
    serializedOutput: Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]),
    failure: false,
  },
];

describe("isMpcFailureOutput", () => {
  it.each(DECODE_CASES)("decodes $name", ({ serializedOutput, failure }) => {
    expect(isMpcFailureOutput(serializedOutput)).toBe(failure);
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
