// Unit tests for the request id computation: determinism, sensitivity to the
// record's contents, and the unsupported-decomposition rejection. The
// lockstep with the compiled `calculateRequestId` circuit is pinned by
// test-caller-contract's round-trip test, not duplicated here.

import { describe, expect, it } from "vitest";

import {
  MPCDestination,
  MPCSignatureAlgorithm,
  TxParamType,
  calculateRequestId,
  evmAddressAbiWord,
  numericAbiWord,
  type SignBidirectionalEvent,
} from "../src/index.ts";

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

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

describe("calculateRequestId", () => {
  it("is deterministic: the same record hashes to the same id", () => {
    expect(calculateRequestId(SAMPLE_REQUEST)).toEqual(
      calculateRequestId(SAMPLE_REQUEST),
    );
  });

  it("changes when any field of the record changes", () => {
    const changed: SignBidirectionalEvent = {
      ...SAMPLE_REQUEST,
      requestNonce: 8n,
    };
    expect(calculateRequestId(changed)).not.toEqual(
      calculateRequestId(SAMPLE_REQUEST),
    );
  });

  it("rejects a decomposition it has no descriptor for", () => {
    expect(() =>
      calculateRequestId({
        ...SAMPLE_REQUEST,
        txParamType: TxParamType.reserved,
      }),
    ).toThrow(/unsupported txParamType 1/);
  });
});
