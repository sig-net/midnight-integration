// Unit tests for the chain-agnostic request-id surface: the untrusted-input
// validation gate (parseRequestIdHex), the canonical hex byte rendering
// (requestIdHex / requestIdBytes), and the ledger-index conversion
// (toSignBidirectionalEventIndex).

import { describe, expect, it } from "vitest";

import {
  calculateRequestId,
  contractAddressFromHex,
  evmAddressAbiWord,
  hexToBytes,
  MPCDestination,
  MPCSignatureAlgorithm,
  numericAbiWord,
  parseRequestIdHex,
  requestIdBytes,
  type RequestIdHex,
  requestIdHex,
  type SignBidirectionalEvent,
  toSignBidirectionalEventIndex,
  TxParamType,
} from "../src/index.ts";

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

/** Known-good request record: the base every test uses. NEVER mutate. */
const SAMPLE_REQUEST: SignBidirectionalEvent = {
  sender: { bytes: bytes(32, 0x01) },
  requestNonce: 7n,
  keyVersion: 1n,
  path: bytes(32, 0x03),
  algo: MPCSignatureAlgorithm.ecdsa,
  dest: MPCDestination.unused,
  params: bytes(64, 0x06),
  txParamType: TxParamType.evmType2,
  txParams: {
    to: bytes(20, 0xaa),
    chainId: 11155111n,
    nonce: 3n,
    gasLimit: 100000n,
    maxFeePerGas: 30000000000n,
    maxPriorityFeePerGas: 2000000000n,
    value: 0n,
    accessListEntryCount: 0n,
    accessList: [],
    calldata: {
      is_some: true,
      value: {
        selector: new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]),
        noWords: 2n,
        words: [evmAddressAbiWord(bytes(20, 0xee)), numericAbiWord(1_000_000n)],
      },
    },
  },
  caip2Id: bytes(32, 0x02),
  outputDeserializationSchema: bytes(34, 0x07),
  respondSerializationSchema: bytes(34, 0x08),
};

describe("parseRequestIdHex", () => {
  // Every accept row normalises to the same literal id, so the expectation
  // never mirrors the implementation's own normalisation.
  it.each([
    { name: "64 lowercase hex chars", input: "ab".repeat(32) },
    { name: "with a 0x prefix", input: `0x${"ab".repeat(32)}` },
    { name: "with a 0X prefix", input: `0X${"ab".repeat(32)}` },
    { name: "uppercase hex is normalised to lowercase", input: "AB".repeat(32) },
    { name: "a 0x prefix with mixed case hex", input: `0x${"Ab".repeat(32)}` },
  ])("accepts $name", ({ input }) => {
    expect(parseRequestIdHex(input)).toBe("ab".repeat(32));
  });

  it.each([
    { name: "63 chars (too short)", input: `${"ab".repeat(31)}a` },
    { name: "65 chars (too long)", input: `${"ab".repeat(32)}a` },
    { name: "non-hex characters", input: `${"ab".repeat(31)}zz` },
    { name: "empty string", input: "" },
  ])("rejects $name", ({ input }) => {
    expect(() => parseRequestIdHex(input)).toThrow(/not a 32-byte request id/);
  });
});

describe("requestIdHex / requestIdBytes", () => {
  it("round-trips bytes -> hex -> bytes as identity", () => {
    const raw = bytes(32, 0x5c);
    const id = requestIdHex(raw);
    expect(id).toHaveLength(64);
    expect(id).toBe(id.toLowerCase());
    expect(id.startsWith("0x")).toBe(false);
    expect(requestIdBytes(id)).toEqual(raw);
  });

  it("requestIdBytes also accepts a 0x-prefixed hex", () => {
    expect(requestIdBytes(`0x${"5c".repeat(32)}` as RequestIdHex)).toEqual(bytes(32, 0x5c));
  });
});

describe("toSignBidirectionalEventIndex", () => {
  const REQUEST_ID = calculateRequestId(SAMPLE_REQUEST);

  it("keys the index by the canonical hex request id", () => {
    const index = toSignBidirectionalEventIndex([[REQUEST_ID, SAMPLE_REQUEST]]);
    expect([...index.keys()]).toEqual([requestIdHex(REQUEST_ID)]);
    expect(index.get(requestIdHex(REQUEST_ID))).toEqual(SAMPLE_REQUEST);
  });

  it("an empty iterable gives an empty index", () => {
    expect(toSignBidirectionalEventIndex([]).size).toBe(0);
  });
});

describe("contractAddressFromHex", () => {
  const HEX = "1df4ce25fc9f9c03dc6f4d0eb12ddf3d0db094995d4c70aca1142eebb3b77a5d";

  it.each([
    ["bare lowercase hex", HEX],
    ["a 0x prefix", `0x${HEX}`],
    ["a 0X prefix and uppercase digits", `0X${HEX.toUpperCase()}`],
  ])("accepts %s", (_name, hex) => {
    expect(contractAddressFromHex(hex)).toEqual({ bytes: hexToBytes(HEX) });
  });

  it.each([
    ["31 bytes", HEX.slice(2)],
    ["33 bytes", `${HEX}00`],
    ["a non-hex digit", `g${HEX.slice(1)}`],
    ["the empty string", ""],
  ])("rejects %s", (_name, hex) => {
    expect(() => contractAddressFromHex(hex)).toThrow(/not a 32-byte contract address in hex/);
  });
});
