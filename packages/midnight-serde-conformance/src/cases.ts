import type { BorshValue, Schema } from "@sig-net/midnight-serde";

import { pureCircuits } from "../managed/contract/index.js";

/** A native Borsh value paired with independently compiled Compact bytes. */
export interface CompatibilityCase {
  name: string;
  schema: Schema;
  value: BorshValue;
  bytes: Uint8Array;
}

/** Native Borsh types with byte-compatible Compact fixtures. */
export const CASES: CompatibilityCase[] = [
  ...[0n, 1n, (1n << 128n) - 1n].map((amount) => ({
    name: "result",
    schema: { struct: { ok: "bool", amount: "u128" } },
    value: { ok: amount !== 0n, amount },
    bytes: pureCircuits.serResult({ ok: amount !== 0n, amount }),
  })),
  { name: "u8", schema: "u8", value: 255, bytes: pureCircuits.serU8(255n) },
  { name: "u16", schema: "u16", value: 65535, bytes: pureCircuits.serU16(65535n) },
  { name: "u32", schema: "u32", value: 4294967295, bytes: pureCircuits.serU32(4294967295n) },
  {
    name: "u64",
    schema: "u64",
    value: (1n << 64n) - 1n,
    bytes: pureCircuits.serU64((1n << 64n) - 1n),
  },
  {
    name: "u128",
    schema: "u128",
    value: (1n << 128n) - 1n,
    bytes: pureCircuits.serU128((1n << 128n) - 1n),
  },
  {
    name: "bytes",
    schema: { array: { type: "u8", len: 4 } },
    value: [1, 2, 3, 4],
    bytes: pureCircuits.serBytes(Uint8Array.of(1, 2, 3, 4)),
  },
  {
    name: "vector",
    schema: { array: { type: "u16", len: 3 } },
    value: [0, 256, 65535],
    bytes: pureCircuits.serVector([0n, 256n, 65535n]),
  },
  ...[false, true].map((is_some) => ({
    name: "maybe",
    schema: { struct: { is_some: "bool", value: "u64" } },
    value: { is_some, value: is_some ? 99n : 0n },
    bytes: pureCircuits.serMaybe({ is_some, value: is_some ? 99n : 0n }),
  })),
  ...[false, true].map((is_left) => ({
    name: "either",
    schema: { struct: { is_left: "bool", left: "u16", right: { array: { type: "u8", len: 4 } } } },
    value: { is_left, left: 7, right: [1, 2, 3, 4] },
    bytes: pureCircuits.serEither({ is_left, left: 7n, right: Uint8Array.of(1, 2, 3, 4) }),
  })),
  {
    name: "enum",
    schema: {
      enum: [
        { struct: { Pending: { struct: {} } } },
        { struct: { Ready: { struct: {} } } },
        { struct: { Done: { struct: {} } } },
      ],
    },
    value: { Done: {} },
    bytes: pureCircuits.serStatus(2),
  },
];
