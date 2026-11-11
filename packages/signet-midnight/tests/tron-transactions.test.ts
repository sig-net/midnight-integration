import { describe, expect, it } from "vitest";

import {
  buildTronRawTransaction,
  bytesToHex,
  deriveEvmAddress,
  deriveTronAddress,
  getMpcRootPublicKey,
  MidnightNetwork,
  tronAddressFromBase58,
  tronAddressFromEvm,
  tronAddressToBase58,
  type TronTxParams,
} from "../src/index.ts";

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

const USDT_BASE58 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_BYTES = "41a614f803b6fd780986a42c78ec9c7f77e6ded13c";

describe("Tron addresses", () => {
  it("renders and parses mainnet USDT", () => {
    expect(tronAddressToBase58(Buffer.from(USDT_BYTES, "hex"))).toBe(USDT_BASE58);
    expect(bytesToHex(tronAddressFromBase58(USDT_BASE58))).toBe(USDT_BYTES);
  });

  it.each([
    { name: "hex with 0x", evm: "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c" },
    { name: "upper-case hex", evm: "A614F803B6FD780986A42C78EC9C7F77E6DED13C" },
    { name: "bytes", evm: Buffer.from("a614f803b6fd780986a42c78ec9c7f77e6ded13c", "hex") },
  ])("converts an EVM address given as $name", ({ evm }) => {
    expect(bytesToHex(tronAddressFromEvm(evm))).toBe(USDT_BYTES);
  });

  it.each([
    {
      name: "a 19-byte hex string",
      evm: "0x" + "ab".repeat(19),
      error: /not a 20-byte EVM address/,
    },
    { name: "a non-hex string", evm: "zz".repeat(20), error: /not a 20-byte EVM address/ },
    { name: "21 bytes", evm: bytes(21, 0xab), error: /must be 20 bytes, got 21/ },
  ])("refuses $name as an EVM address", ({ evm, error }) => {
    expect(() => tronAddressFromEvm(evm)).toThrow(error);
  });

  it.each([
    {
      name: "a changed character",
      text: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u",
      error: /checksum mismatch/,
    },
    {
      name: "a non-base58 character",
      text: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj60",
      error: /not a base58/,
    },
    { name: "a short text", text: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj", error: /expected 25 bytes/ },
    {
      name: "a checksummed payload with a 0x42 prefix",
      text: "TpSyGx2w2bR9GdrDrYtrYwbvSPhwSmg7ER",
      error: /21 bytes with the 0x41 prefix/,
    },
  ])("refuses $name in base58", ({ text, error }) => {
    expect(() => tronAddressFromBase58(text)).toThrow(error);
  });

  it.each([
    { name: "20 bytes", address: bytes(20, 0x41) },
    { name: "a 0x42 prefix", address: Uint8Array.from([0x42, ...bytes(20, 0xab)]) },
  ])("refuses to render $name", ({ address }) => {
    expect(() => tronAddressToBase58(address)).toThrow(/21 bytes with the 0x41 prefix/);
  });

  it("derives the request signing key's address: the EVM address in Tron form", () => {
    const root = getMpcRootPublicKey(MidnightNetwork.Preview);
    const contract = "ab".repeat(32);
    const path = "03".repeat(32);
    const derived = deriveTronAddress(root, contract, path);
    expect(derived.bytes).toEqual(tronAddressFromEvm(deriveEvmAddress(root, contract, path)));
    expect(derived.base58).toBe(tronAddressToBase58(derived.bytes));
    expect(derived.base58.startsWith("T")).toBe(true);
  });
});

const VALID_PARAMS: TronTxParams = {
  refBlockBytes: Uint8Array.from([0x27, 0x10]),
  refBlockHash: bytes(8, 0x42),
  timestamp: 1_728_000_000_000n,
  expiration: 1_728_000_060_000n,
  feeLimit: 50_000_000n,
  contractAddress: Uint8Array.from([0x41, ...bytes(20, 0xcd)]),
  callValue: 0n,
  calldata: {
    is_some: true,
    value: { selector: bytes(4, 0xab), noWords: 1n, words: [bytes(32, 0x11)] },
  },
};
const OWNER = Uint8Array.from([0x41, ...bytes(20, 0xab)]);

describe("buildTronRawTransaction", () => {
  it("assembles a valid transaction", () => {
    expect(buildTronRawTransaction(VALID_PARAMS, OWNER).length).toBeGreaterThan(0);
  });

  it.each([
    {
      name: "a 3-byte refBlockBytes",
      params: { ...VALID_PARAMS, refBlockBytes: bytes(3, 1) },
      owner: OWNER,
      error: /refBlockBytes must be TaPoS' two bytes/,
    },
    {
      name: "a 7-byte refBlockHash",
      params: { ...VALID_PARAMS, refBlockHash: bytes(7, 1) },
      owner: OWNER,
      error: /refBlockHash must be TaPoS' eight bytes/,
    },
    {
      name: "a zero expiration",
      params: { ...VALID_PARAMS, expiration: 0n },
      owner: OWNER,
      error: /missing expiration/,
    },
    {
      name: "an owner without the 0x41 prefix",
      params: VALID_PARAMS,
      owner: Uint8Array.from([0x42, ...bytes(20, 0xab)]),
      error: /owner address must be 21 bytes with the 0x41 prefix/,
    },
    {
      name: "a 20-byte contract address",
      params: { ...VALID_PARAMS, contractAddress: bytes(20, 0xcd) },
      owner: OWNER,
      error: /contract address must be 21 bytes with the 0x41 prefix/,
    },
    {
      name: "an expiration past int64",
      params: { ...VALID_PARAMS, expiration: 2n ** 63n },
      owner: OWNER,
      error: /expiration 9223372036854775808 exceeds the int64 wire field/,
    },
    {
      name: "a call value past int64",
      params: { ...VALID_PARAMS, callValue: 2n ** 64n - 1n },
      owner: OWNER,
      error: /callValue 18446744073709551615 exceeds the int64 wire field/,
    },
    {
      name: "a word count past the stored words",
      params: {
        ...VALID_PARAMS,
        calldata: { is_some: true, value: { ...VALID_PARAMS.calldata.value, noWords: 2n } },
      },
      owner: OWNER,
      error: /calldata noWords 2 exceeds the capacity of 1/,
    },
  ])("refuses $name", ({ params, owner, error }) => {
    expect(() => buildTronRawTransaction(params, owner)).toThrow(error);
  });
});
