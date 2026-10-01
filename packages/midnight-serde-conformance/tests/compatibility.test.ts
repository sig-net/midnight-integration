import { readFileSync } from "node:fs";

import { compactDeserialize, compactSerialize } from "@sig-net/midnight-serde";
import { describe, expect, it } from "vitest";

import { pureCircuits } from "../managed/contract/index.js";
import { CASES } from "../src/cases.ts";
import { fixtureIdentity } from "../src/toolchain.ts";

describe("Borsh and compiled Compact compatibility", () => {
  it("verifies the compiler identity and a non-empty corpus", () => {
    expect(fixtureIdentity().release).toBe("0.33.0-rc.2");
    expect(CASES.length).toBeGreaterThan(0);
  });
  it.each(CASES)("$name", ({ schema, value, bytes }) => {
    expect(compactSerialize(schema, value)).toEqual(bytes);
    expect(compactDeserialize(schema, bytes)).toEqual(value);
  });
  it("pins the Rust corpus to the compiled fixture bytes", () => {
    const actual = JSON.parse(
      readFileSync(new URL("../corpus/borsh-corpus.json", import.meta.url), "utf8"),
    ) as object;
    const expected = CASES.map(({ name, value, bytes }) => ({
      name,
      value,
      hex: Buffer.from(bytes).toString("hex"),
    }));
    expect(actual).toEqual(
      JSON.parse(
        JSON.stringify(
          expected,
          (_key, value: object | string | number | bigint | boolean | null) =>
            typeof value === "bigint" ? value.toString() : value,
        ),
      ),
    );
  });
  it("records compatibility limits without rejecting Borsh schemas", () => {
    expect(compactSerialize({ option: "u64" }, null)).toHaveLength(1);
    expect(pureCircuits.serNone()).toHaveLength(9);
    expect(compactDeserialize("bool", Uint8Array.of(2))).toBe(true);
    expect(pureCircuits.deBool(Uint8Array.of(2))).toBe(false);
    expect(() => pureCircuits.deU12(compactSerialize("u16", 4096))).toThrow();
    expect(compactSerialize({ array: { type: "u8", len: 0 } }, [])).toHaveLength(4);
    expect(pureCircuits.serEmpty()).toEqual(Uint8Array.of(90));
  });
});
