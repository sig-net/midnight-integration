// Unit tests for the v2.0.0 epsilon EVM-address derivation, the only scheme the
// MPC answers. Golden vectors were generated from an independent construction of
// `caip2_derivation_path` (MPC crypto/src/kdf.rs): the colon-separated string
// built by hand, keccak'd, then root + epsilon*G with noble. Sharing no code with
// the implementation is the point: these must not be regenerated from it.

import { describe, expect, it } from "vitest";

import {
  deriveEvmAddress,
  deriveMidnightResponseKey,
  deriveMidnightResponseSecretKey,
  secp256k1PublicKeyOf,
} from "../src/index.ts";

// The compressed secp256k1 public key of the fixed MPC root key 9e3b…9e0f
// from the golden-vector run (also asserted in mpc-keys.test.ts).
const MPC_PUBKEY = "0x0281e037488c6e708c5a28c8bc2e43b7a704f3a869bd129fb6511bcc58e98db243";
const CONTRACT_ADDRESS = "0200e5e9a4f3d1b2c6a7889900aabbccddeeff00112233445566778899aabbccdd";
const COMMITMENT_HEX = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

interface Case {
  name: string;
  path: string;
  chainId: string | undefined;
  expected: string;
}

const CASES: Case[] = [
  {
    name: "vault path, default midnight:testnet chain id",
    path: "vault",
    chainId: undefined,
    expected: "0x607622ceB3b0f430EaC738B8FeBD577F6d11D37F",
  },
  {
    name: "user commitment-hex path, default chain id",
    path: COMMITMENT_HEX,
    chainId: undefined,
    expected: "0x9865db6544a77649187636fCAcb6b2bBC0eD8393",
  },
  {
    name: "explicit non-default chain id changes the derivation",
    path: "vault",
    chainId: "eip155:11155111",
    expected: "0x11F95e6098FC53fD106506F8b42726990b176348",
  },
];

describe("deriveEvmAddress", () => {
  it.each(CASES)("$name", ({ path, chainId, expected }) => {
    const address = chainId
      ? deriveEvmAddress(MPC_PUBKEY, CONTRACT_ADDRESS, path, chainId)
      : deriveEvmAddress(MPC_PUBKEY, CONTRACT_ADDRESS, path);
    expect(address).toBe(expected);
  });

  it("accepts the uncompressed form of the same root public key", () => {
    // 04 || x || y expansion of MPC_PUBKEY: same key, same derived address.
    const uncompressed =
      "0x0481e037488c6e708c5a28c8bc2e43b7a704f3a869bd129fb6511bcc58e98db243" +
      "4fd9fffb61ad2ff6c6423cbd51e2d8d9535fef116d48dfeedce3276db6a53446";
    expect(deriveEvmAddress(uncompressed, CONTRACT_ADDRESS, "vault")).toBe(
      "0x607622ceB3b0f430EaC738B8FeBD577F6d11D37F",
    );
  });

  it("rejects a malformed public key", () => {
    expect(() => deriveEvmAddress("0x1234", CONTRACT_ADDRESS, "vault")).toThrow();
  });
});

// The root secret key behind MPC_PUBKEY (the mpc-keys golden root key).
const MPC_ROOT_SECRET = Uint8Array.from(
  Buffer.from("9e3b2f8d1c4a5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f", "hex"),
);
const CLIENT_ADDRESS = CONTRACT_ADDRESS;

describe("deriveMidnightResponseKey / deriveMidnightResponseSecretKey", () => {
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
