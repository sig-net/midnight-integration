// Raw-cell decoding of a stored evmType2 request record: build a valid cell
// with the canonical descriptor, assert it decodes back to the record, then
// tamper copies of the cell's value/alignment to hit every refusal branch.
// The error messages are the lockstep surface with the MPC's Rust reader
// (chain-signatures/chain-midnight/src/reader.rs), so each one is pinned.

import type { AlignedValue, AlignmentSegment } from "@midnight-ntwrk/compact-runtime";
import { describe, expect, it } from "vitest";

import {
  evmAddressAbiWord,
  MPCDestination,
  MPCSignatureAlgorithm,
  numericAbiWord,
  type SignBidirectionalEvent,
  TxParamType,
} from "../src/index.ts";
import { decodeEvmType2SignBidirectionalEvent } from "../src/signet-evtype2tx-record-decoding.ts";
import { signBidirectionalEventDescriptor } from "../src/signet-evtype2tx-requests.ts";

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
        selector: bytes(4, 0xab),
        noWords: 2n,
        words: [evmAddressAbiWord(bytes(20, 0xee)), numericAbiWord(1_000_000n)],
      },
    },
  },
  caip2Id: bytes(32, 0x02),
  outputDeserializationSchema: bytes(34, 0x07),
  respondSerializationSchema: bytes(34, 0x08),
};

/** SAMPLE_REQUEST with one access-list entry of 2-key capacity. */
const ACCESS_LIST_REQUEST: SignBidirectionalEvent = {
  ...SAMPLE_REQUEST,
  txParams: {
    ...SAMPLE_REQUEST.txParams,
    accessListEntryCount: 1n,
    accessList: [
      {
        address: bytes(20, 0xcc),
        storageKeyCount: 1n,
        storageKeys: [bytes(32, 0x11), bytes(32, 0)],
      },
    ],
  },
};

/** SAMPLE_REQUEST with two empty access-list entries of 0-key capacity. */
const TWO_ENTRY_REQUEST: SignBidirectionalEvent = {
  ...SAMPLE_REQUEST,
  txParams: {
    ...SAMPLE_REQUEST.txParams,
    accessListEntryCount: 2n,
    accessList: [
      { address: bytes(20, 0xcc), storageKeyCount: 0n, storageKeys: [] },
      { address: bytes(20, 0xdd), storageKeyCount: 0n, storageKeys: [] },
    ],
  },
};

/** Encode `request` as a stored cell at the given capacity instantiation. */
const cellOf = (
  request: SignBidirectionalEvent,
  capacities: readonly [number, number, number],
): AlignedValue => {
  const descriptor = signBidirectionalEventDescriptor(
    capacities[0],
    capacities[1],
    capacities[2],
    request.outputDeserializationSchema.length,
    request.respondSerializationSchema.length,
  );
  return { value: descriptor.toValue(request), alignment: descriptor.alignment() };
};

/** A copy of `cell` with one alignment segment replaced. */
const withAlignment = (
  cell: AlignedValue,
  index: number,
  segment: AlignmentSegment,
): AlignedValue => ({
  value: cell.value,
  alignment: cell.alignment.map((s, i) => (i === index ? segment : s)),
});

/** A copy of `cell` with the atoms at `drop` (same indices in value and alignment) removed. */
const withoutAtoms = (cell: AlignedValue, drop: readonly number[]): AlignedValue => ({
  value: cell.value.filter((_, i) => !drop.includes(i)),
  alignment: cell.alignment.filter((_, i) => !drop.includes(i)),
});

describe("decodeEvmType2SignBidirectionalEvent", () => {
  it("decodes a valid record back to itself", () => {
    expect(
      decodeEvmType2SignBidirectionalEvent(cellOf(SAMPLE_REQUEST, [2, 0, 0]), "test record"),
    ).toEqual(SAMPLE_REQUEST);
  });

  it("recovers the capacity instantiation of a wider record", () => {
    expect(
      decodeEvmType2SignBidirectionalEvent(cellOf(ACCESS_LIST_REQUEST, [2, 1, 2]), "test record"),
    ).toEqual(ACCESS_LIST_REQUEST);
  });

  it("rejects a cell whose alignment count differs from its atom count", () => {
    const { value, alignment } = cellOf(SAMPLE_REQUEST, [2, 0, 0]);
    expect(() =>
      decodeEvmType2SignBidirectionalEvent({ value: value.slice(0, 20), alignment }, "test record"),
    ).toThrow(/declares 24 alignment segments for 20 atoms/);
  });

  it("rejects an alignment segment that is not an atom", () => {
    expect(() =>
      decodeEvmType2SignBidirectionalEvent(
        withAlignment(cellOf(SAMPLE_REQUEST, [2, 0, 0]), 0, {
          tag: "option",
          value: [],
        }),
        "test record",
      ),
    ).toThrow(/atom 0 is an alignment option/);
  });

  it("rejects an atom aligned to a non-bytes kind", () => {
    expect(() =>
      decodeEvmType2SignBidirectionalEvent(
        withAlignment(cellOf(SAMPLE_REQUEST, [2, 0, 0]), 1, {
          tag: "atom",
          value: { tag: "field" },
        }),
        "test record",
      ),
    ).toThrow(/atom 1 is aligned 'field', which carries no byte width/);
  });

  it("rejects a cell with fewer than the fixed field count of atoms", () => {
    const { value, alignment } = cellOf(SAMPLE_REQUEST, [2, 0, 0]);
    expect(() =>
      decodeEvmType2SignBidirectionalEvent(
        { value: value.slice(0, 21), alignment: alignment.slice(0, 21) },
        "test record",
      ),
    ).toThrow(/fewer than the 22 its fixed fields need/);
  });

  it("rejects a cell missing the Bytes<1> access-list entry count", () => {
    expect(() =>
      decodeEvmType2SignBidirectionalEvent(
        // Atom 20 is the entry count after 2 calldata words: widen it to 2.
        withAlignment(cellOf(SAMPLE_REQUEST, [2, 0, 0]), 20, {
          tag: "atom",
          value: { tag: "bytes", length: 2 },
        }),
        "test record",
      ),
    ).toThrow(/expected the Bytes<1> access-list entry count/);
  });

  it("rejects a non-empty access-list region with no Bytes<20> address", () => {
    expect(() =>
      decodeEvmType2SignBidirectionalEvent(
        // Atom 21 is the entry address: widen it away from 20 bytes.
        withAlignment(cellOf(ACCESS_LIST_REQUEST, [2, 1, 2]), 21, {
          tag: "atom",
          value: { tag: "bytes", length: 21 },
        }),
        "test record",
      ),
    ).toThrow(/declares no Bytes<20> entry address/);
  });

  it("rejects a region whose atoms do not divide evenly across its entries", () => {
    const { value, alignment } = cellOf(TWO_ENTRY_REQUEST, [2, 2, 0]);
    expect(() =>
      decodeEvmType2SignBidirectionalEvent(
        // Drop the final tail atom: the two-entry region becomes 3 atoms,
        // which 2 entries cannot divide evenly.
        { value: value.slice(0, 27), alignment: alignment.slice(0, 27) },
        "test record",
      ),
    ).toThrow(/do not divide evenly/);
  });

  it("rejects a region with fewer than two atoms per entry", () => {
    expect(() =>
      decodeEvmType2SignBidirectionalEvent(
        // Drop both per-entry key-count atoms: two addresses with no counts,
        // an even region the measurement still refuses.
        withoutAtoms(cellOf(TWO_ENTRY_REQUEST, [2, 2, 0]), [22, 24]),
        "test record",
      ),
    ).toThrow(/each access-list entry needs at least an address and a key count/);
  });
});
