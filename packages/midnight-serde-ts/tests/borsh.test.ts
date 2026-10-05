import { deserialize, type Schema, serialize } from "borsh";
import { describe, expect, it } from "vitest";

import { type BorshValue, compactDeserialize, compactSerialize } from "../src/index.ts";

describe("native Borsh delegation", () => {
  const cases: { name: string; schema: Schema; value: BorshValue }[] = [
    {
      name: "struct",
      schema: { struct: { ok: "bool", amount: "u128" } },
      value: { ok: true, amount: 4242n },
    },
    { name: "dynamic array", schema: { array: { type: "u16" } }, value: [1, 256] },
    { name: "signed integer", schema: "i64", value: -7n },
    { name: "string", schema: "string", value: "hello" },
    { name: "option", schema: { option: "u64" }, value: null },
    { name: "empty fixed array", schema: { array: { type: "u8", len: 0 } }, value: [] },
    {
      name: "enum",
      schema: { enum: [{ struct: { Left: "u64" } }, { struct: { Right: "bool" } }] },
      value: { Left: 99n },
    },
    { name: "map", schema: { map: { key: "string", value: "u32" } }, value: new Map([["a", 7]]) },
  ];
  it.each(cases)("$name", ({ schema, value }) => {
    const bytes = compactSerialize(schema, value);
    expect(bytes).toEqual(serialize(schema, value));
    expect(compactDeserialize(schema, bytes)).toEqual(deserialize(schema, bytes));
    expect(compactDeserialize(schema, bytes)).toEqual(value);
  });
  it("pads a native struct and reads its prefix", () => {
    const schema = { struct: { ok: "bool", amount: "u128" } };
    const value = { ok: true, amount: 4242n };
    const bytes = compactSerialize(schema, value, 128);
    expect(bytes).toHaveLength(128);
    expect(bytes.subarray(0, 17)).toEqual(serialize(schema, value));
    expect(bytes.subarray(17)).toEqual(new Uint8Array(111));
    expect(compactDeserialize(schema, bytes)).toEqual(value);
  });
  it.each([-1, 0, 1.5, Number.NaN])("rejects invalid output length %s", (length) => {
    expect(() => compactSerialize("u16", 7, length)).toThrow(RangeError);
  });
  it("keeps native decoding and integer overflow behaviour", () => {
    expect(compactDeserialize("bool", Uint8Array.of(2))).toBe(true);
    expect(compactDeserialize("u8", Uint8Array.of(7, 255))).toBe(7);
    expect(compactSerialize("u128", 1n << 128n)).toEqual(new Uint8Array(16));
    expect(() => compactDeserialize("u64", Uint8Array.of(1))).toThrow();
  });
});
