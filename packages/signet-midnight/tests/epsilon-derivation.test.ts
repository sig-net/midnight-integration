// Unit tests for the v2.0.0 epsilon EVM-address derivation, the only scheme the
// MPC answers. Golden vectors were generated from an independent construction of
// `caip2_derivation_path` (MPC signet-crypto/src/kdf.rs): the colon-separated
// string built by hand with the fixed `midnight:mainnet` chain id, keccak'd,
// then root + epsilon*G with noble. Sharing no code with the implementation is
// the point: these must not be regenerated from it.

import { computeAddress, encodeBase58 } from "ethers";
import { describe, expect, it } from "vitest";

import {
  asciiPadded,
  bytesToHex,
  deriveEpsilon,
  deriveEvmAddress,
  deriveMidnightRequestSigningKey,
  deriveMidnightResponseKey,
  deriveSignBidirectionalEventSignerEvmAddress,
  deriveSignBidirectionalEventSigningKey,
  EPSILON_DERIVATION_PREFIX,
  formatSecp256k1PublicKey,
  hexToBytes,
  MIDNIGHT_CAIP2_ID,
  MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH,
  parseSecp256k1PublicKey,
} from "../src/index.ts";
import { deriveMidnightResponseSecretKey, secp256k1PublicKeyOf } from "../src/testing.ts";

// The compressed secp256k1 public key of the fixed MPC root key 9e3b…9e0f
// from the golden-vector run (also asserted in mpc-keys.test.ts).
const MPC_PUBKEY = "0x0281e037488c6e708c5a28c8bc2e43b7a704f3a869bd129fb6511bcc58e98db243";
const CONTRACT_ADDRESS = "0200e5e9a4f3d1b2c6a7889900aabbccddeeff00112233445566778899aabbccdd";
const COMMITMENT_HEX = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

interface Case {
  name: string;
  path: string;
  expected: string;
}

const CASES: Case[] = [
  {
    name: "vault path",
    path: "vault",
    expected: "0x3d4C6Ebe9016168397F6E15De5fd2412e2FB222C",
  },
  {
    name: "user commitment-hex path",
    path: COMMITMENT_HEX,
    expected: "0x286BC9Fb1CfBaC876471ee2aF17976b4336Adb65",
  },
];

describe("deriveEvmAddress", () => {
  it.each(CASES)("$name", ({ path, expected }) => {
    expect(deriveEvmAddress(MPC_PUBKEY, CONTRACT_ADDRESS, path)).toBe(expected);
  });

  // 04 || x || y expansion of MPC_PUBKEY: same key, same derived address.
  const UNCOMPRESSED =
    "0x0481e037488c6e708c5a28c8bc2e43b7a704f3a869bd129fb6511bcc58e98db243" +
    "4fd9fffb61ad2ff6c6423cbd51e2d8d9535fef116d48dfeedce3276db6a53446";

  it("accepts the uncompressed form of the same root public key", () => {
    expect(deriveEvmAddress(UNCOMPRESSED, CONTRACT_ADDRESS, "vault")).toBe(
      "0x3d4C6Ebe9016168397F6E15De5fd2412e2FB222C",
    );
  });

  it("accepts the NEAR form of the same root public key", () => {
    // secp256k1: + base58 of the raw X||Y point, the 04 byte dropped.
    const nearForm = `secp256k1:${encodeBase58(hexToBytes(UNCOMPRESSED.slice(4)))}`;
    expect(deriveEvmAddress(nearForm, CONTRACT_ADDRESS, "vault")).toBe(
      "0x3d4C6Ebe9016168397F6E15De5fd2412e2FB222C",
    );
  });

  it("rejects a malformed public key", () => {
    expect(() => deriveEvmAddress("0x1234", CONTRACT_ADDRESS, "vault")).toThrow();
  });

  it("normalises the requester: 0x prefix and case do not change the address", () => {
    const canonical = deriveEvmAddress(MPC_PUBKEY, CONTRACT_ADDRESS, "vault");
    expect(deriveEvmAddress(MPC_PUBKEY, `0x${CONTRACT_ADDRESS}`, "vault")).toBe(canonical);
    expect(deriveEvmAddress(MPC_PUBKEY, CONTRACT_ADDRESS.toUpperCase(), "vault")).toBe(canonical);
  });
});

// Cross-implementation vectors for accounts derived from an on-ledger
// record's `path: Bytes<32>`: the MPC renders the path as the lowercase hex
// of the FULL 32 bytes, verbatim (sig-net/mpc chain-midnight convert.rs), so
// the TS side must reach the same address via bytesToHex. Golden addresses
// were generated from an independent construction of the derivation string,
// like the CASES above: never regenerate them from the implementation.
describe("deriveEvmAddress from record path bytes (MPC hex rendering)", () => {
  interface PathBytesCase {
    name: string;
    pathBytes: Uint8Array;
    expectedPathHex: string;
    expectedAddress: string;
  }

  const PATH_BYTES_CASES: PathBytesCase[] = [
    {
      // A text-style path: the zero padding is part of the rendering.
      name: "padded ascii literal pad(32, 'caller-path')",
      pathBytes: asciiPadded("caller-path", 32),
      expectedPathHex: "63616c6c65722d70617468000000000000000000000000000000000000000000",
      expectedAddress: "0x26c05D12f8147C8428dcda4d263736062BDE5eA4",
    },
    {
      // A commitment-style path: invalid UTF-8, an interior NUL and a
      // trailing zero byte, all rendered verbatim (the rendering is total).
      name: "raw commitment bytes with interior and trailing NULs",
      pathBytes: new Uint8Array([
        0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6, 0x07, 0x18, 0xff, 0xfe, 0x00, 0x5c, 0x6d, 0x7e, 0x8f,
        0x90, 0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6, 0x07, 0x18, 0x29, 0x3a, 0x4b, 0x5c, 0x6d, 0x7e,
        0x8f, 0x00,
      ]),
      expectedPathHex: "a1b2c3d4e5f60718fffe005c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f00",
      expectedAddress: "0xA05732714EBC6c2366F2876CC817c9998efDc789",
    },
  ];

  it.each(PATH_BYTES_CASES)("$name", ({ pathBytes, expectedPathHex, expectedAddress }) => {
    const pathHex = bytesToHex(pathBytes);
    expect(pathHex).toBe(expectedPathHex);
    expect(deriveEvmAddress(MPC_PUBKEY, CONTRACT_ADDRESS, pathHex)).toBe(expectedAddress);
  });
});

// The key functions are pinned to the SAME independent golden addresses: an
// EVM address is the keccak of its public key, so a key whose address matches
// a golden vector is the key that vector was constructed from.
describe("deriveMidnightRequestSigningKey", () => {
  it.each(CASES)("$name: the key's EVM address is the golden address", ({ path, expected }) => {
    const key = deriveMidnightRequestSigningKey(MPC_PUBKEY, CONTRACT_ADDRESS, path);
    expect(key.identity).toBe(false);
    expect(computeAddress(formatSecp256k1PublicKey(key))).toBe(expected);
  });

  it("round-trips through the published key spelling", () => {
    const key = deriveMidnightRequestSigningKey(MPC_PUBKEY, CONTRACT_ADDRESS, "vault");
    expect(parseSecp256k1PublicKey(formatSecp256k1PublicKey(key))).toEqual(key);
  });

  it("is a different key from the contract's response key", () => {
    expect(deriveMidnightRequestSigningKey(MPC_PUBKEY, CONTRACT_ADDRESS, "vault")).not.toEqual(
      deriveMidnightResponseKey(MPC_PUBKEY, CONTRACT_ADDRESS),
    );
  });
});

describe("deriveSignBidirectionalEventSigningKey / ...SignerEvmAddress", () => {
  interface RecordCase {
    name: string;
    path: Uint8Array;
    expectedAddress: string;
  }

  // The PATH_BYTES_CASES golden addresses, reached from a record: the
  // functions under test render `sender` and `path` themselves.
  const RECORD_CASES: RecordCase[] = [
    {
      name: "padded ascii literal pad(32, 'caller-path')",
      path: asciiPadded("caller-path", 32),
      expectedAddress: "0x26c05D12f8147C8428dcda4d263736062BDE5eA4",
    },
    {
      name: "raw commitment bytes with interior and trailing NULs",
      path: hexToBytes("a1b2c3d4e5f60718fffe005c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f00"),
      expectedAddress: "0xA05732714EBC6c2366F2876CC817c9998efDc789",
    },
  ];
  const SENDER = { bytes: hexToBytes(CONTRACT_ADDRESS) };

  it.each(RECORD_CASES)("$name", ({ path, expectedAddress }) => {
    expect(deriveSignBidirectionalEventSignerEvmAddress(MPC_PUBKEY, { sender: SENDER, path })).toBe(
      expectedAddress,
    );
    expect(
      computeAddress(
        formatSecp256k1PublicKey(
          deriveSignBidirectionalEventSigningKey(MPC_PUBKEY, { sender: SENDER, path }),
        ),
      ),
    ).toBe(expectedAddress);
  });

  it("another sender derives another key for the same path", () => {
    const path = asciiPadded("caller-path", 32);
    expect(
      deriveSignBidirectionalEventSigningKey(MPC_PUBKEY, {
        sender: { bytes: new Uint8Array(32).fill(0x01) },
        path,
      }),
    ).not.toEqual(deriveSignBidirectionalEventSigningKey(MPC_PUBKEY, { sender: SENDER, path }));
  });
});

// The root secret key behind MPC_PUBKEY (the mpc-keys golden root key).
const MPC_ROOT_SECRET = Uint8Array.from(
  Buffer.from("9e3b2f8d1c4a5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f", "hex"),
);
const CLIENT_ADDRESS = CONTRACT_ADDRESS;

describe("deriveMidnightResponseKey / deriveMidnightResponseSecretKey", () => {
  it("matches the independently constructed response key, public and secret side", () => {
    const expected = parseSecp256k1PublicKey(
      "033bd4c0204cec4b87d1d3e15f75051dba7e1e80ffaa3c83853192a41bc18ed8c2",
    );
    expect(deriveMidnightResponseKey(MPC_PUBKEY, CLIENT_ADDRESS)).toEqual(expected);
    expect(
      secp256k1PublicKeyOf(deriveMidnightResponseSecretKey(MPC_ROOT_SECRET, CLIENT_ADDRESS)),
    ).toEqual(expected);
  });

  it("secret and public derivations agree: pub(secret) == derived public key", () => {
    const secret = deriveMidnightResponseSecretKey(MPC_ROOT_SECRET, CLIENT_ADDRESS);
    expect(secp256k1PublicKeyOf(secret)).toEqual(
      deriveMidnightResponseKey(MPC_PUBKEY, CLIENT_ADDRESS),
    );
  });

  it("is not the root key", () => {
    expect(deriveMidnightResponseKey(MPC_PUBKEY, CLIENT_ADDRESS)).not.toEqual(
      secp256k1PublicKeyOf(MPC_ROOT_SECRET),
    );
  });

  it("is scoped per client contract: a different address derives a different key", () => {
    const other = "ff".repeat(32);
    expect(deriveMidnightResponseKey(MPC_PUBKEY, other)).not.toEqual(
      deriveMidnightResponseKey(MPC_PUBKEY, CLIENT_ADDRESS),
    );
  });

  it("normalises the address: 0x prefix and case do not change the key", () => {
    const canonical = deriveMidnightResponseKey(MPC_PUBKEY, CLIENT_ADDRESS);
    expect(deriveMidnightResponseKey(MPC_PUBKEY, `0x${CLIENT_ADDRESS}`)).toEqual(canonical);
    expect(deriveMidnightResponseKey(MPC_PUBKEY, CLIENT_ADDRESS.toUpperCase())).toEqual(canonical);
  });

  it("rejects a root secret key that is not 32 bytes", () => {
    expect(() => deriveMidnightResponseSecretKey(new Uint8Array(31), CLIENT_ADDRESS)).toThrow(
      /32 bytes/,
    );
  });
});

// The MPC's own golden fixture (sig-net/mpc signet-crypto/fixtures/
// midnight-epsilon.json), which its `midnight_epsilon_matches_the_reference_
// implementation` test asserts `derive_epsilon_midnight(1, ...)` against.
// Pinning the same constants and epsilons here keeps both sides of the
// protocol on one derivation string. Never regenerate these from this
// implementation: copy them from the MPC fixture.
describe("agrees with the MPC's midnight-epsilon golden fixture", () => {
  const FIXTURE_REQUESTER = "abf32e141d471192a834779b0a8960aa05a7f94534564f477420eef80f588c48";

  interface FixtureVector {
    requester: string;
    path: string;
    epsilon: string;
  }

  const FIXTURE_VECTORS: FixtureVector[] = [
    {
      requester: FIXTURE_REQUESTER,
      path: "vault",
      epsilon: "3c6fb4087edbc9e2cbea5e949a3a6dee2a143aecea25c079e1db314ece1319b1",
    },
    {
      requester: FIXTURE_REQUESTER,
      path: "midnight response key",
      epsilon: "e4748f4561c2a6090cf9f70ed68f26b81d637bf38bc832371d33b4823c0ccafa",
    },
    {
      requester: FIXTURE_REQUESTER,
      path: "",
      epsilon: "d9763868f45b3e9c7da74a4410abe07af53a792e1dcc9881f9d788c0cff15898",
    },
    {
      requester: "0".repeat(64),
      path: "a:b:c",
      epsilon: "3d7d62f5c521828a861cbe7dab3ab7ac86707b73abf84711b986e724f534d974",
    },
  ];

  it("pins the fixture's constants", () => {
    expect(EPSILON_DERIVATION_PREFIX).toBe("sig.network v2.0.0 epsilon derivation");
    expect(MIDNIGHT_CAIP2_ID).toBe("midnight:mainnet");
    expect(MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH).toBe("midnight response key");
  });

  it.each(FIXTURE_VECTORS)("requester $requester, path $path", ({ requester, path, epsilon }) => {
    expect(deriveEpsilon(requester, path).toString(16).padStart(64, "0")).toBe(epsilon);
  });
});
