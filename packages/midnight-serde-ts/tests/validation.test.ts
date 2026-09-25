import { describe, expect, it } from "vitest";

import { compactSerialize, type CompactType } from "../src/index.ts";

const VECTOR = {
  kind: "vector",
  length: 3,
  element: { kind: "uint", bits: 8 },
} as const satisfies CompactType;
const RECORD = {
  kind: "struct",
  fields: [
    { name: "items", type: VECTOR },
    { name: "marker", type: { kind: "uint", bits: 8 } },
  ],
} as const satisfies CompactType;

describe("vector element validation", () => {
  it.each([0, 1, 2])("rejects a hole at position %i before a following field", (index) => {
    const items = [1n, 2n, 3n];
    Reflect.deleteProperty(items, index);
    expect(() => compactSerialize(VECTOR, items)).toThrow(
      `value[${String(index)}]: missing element`,
    );
    expect(() => compactSerialize(RECORD, { items, marker: 9n })).toThrow(
      `value.items[${String(index)}]: missing element`,
    );
  });

  it.each([0, 1, 2])("rejects explicit undefined at position %i", (index) => {
    const items = [1n, 2n, 3n];
    Object.defineProperty(items, index, { value: undefined });
    expect(() => compactSerialize(VECTOR, items)).toThrow(/missing element/);
  });

  it("preserves the vector and following field offsets", () => {
    expect(compactSerialize(RECORD, { items: [0n, 7n, 8n], marker: 9n })).toEqual(
      Uint8Array.of(0, 7, 8, 9),
    );
  });
});
