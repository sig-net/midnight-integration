import { expect, it } from "vitest";

import { assertCompilerCoverage, compilerCases } from "../src/compiler-cases.ts";

it("retains the complete compiler sweep", () => {
  expect(() => {
    assertCompilerCoverage(compilerCases());
  }).not.toThrow();
});

it.each([1, 12, 248])("rejects missing Uint<%i> coverage", (bits) => {
  const cases = compilerCases().filter(
    (c) => !(c.type.kind === "uint" && "bits" in c.type && c.type.bits === bits),
  );
  expect(() => {
    assertCompilerCoverage(cases);
  }).toThrow(`Missing Uint<${String(bits)}>`);
});

it("rejects empty value samples", () => {
  const cases = compilerCases();
  const first = cases[0];
  expect(first).toBeDefined();
  if (first === undefined) throw new Error("Empty compiler sweep");
  first.values = [];
  expect(() => {
    assertCompilerCoverage(cases);
  }).toThrow("no values");
});
