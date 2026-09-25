import * as runtime from "@midnight-ntwrk/compact-runtime";
import * as codec from "@sig-net/midnight-serde";
import { expect, it } from "vitest";

import { pureCircuits } from "../managed/contract/index.js";
import { oracleSerialize, supportsFabOracle } from "../src/oracle.ts";

it.each([
  ["secp256k1-base", codec.SECP256K1_BASE_MODULUS, runtime.SECP256K1_BASE_MODULUS],
  ["secp256k1-scalar", codec.SECP256K1_SCALAR_MODULUS, runtime.SECP256K1_SCALAR_MODULUS],
] as const)("pins %s bounds and descriptor inference", (kind, modulus, sdkModulus) => {
  const type = { kind };
  expect(modulus).toBe(sdkModulus);
  for (const value of [-1n, modulus, modulus + 1n]) {
    expect(() => codec.compactSerialize(type, value)).toThrow();
  }
  const bytes = codec.compactSerialize(type, modulus - 1n);
  const decoded = codec.compactDeserialize(type, bytes);
  expect(decoded).toBe(modulus - 1n);
  expect(supportsFabOracle(type)).toBe(false);
  expect(() => oracleSerialize(type, 0n)).toThrow();
});

it("distinguishes builtin serialisation from the foreign-field FAB shift", () => {
  const bytes = pureCircuits.serSecp256k1Base(1n);
  const fab = runtime.toBinaryRepr(runtime.CompactTypeSecp256k1Base, 1n);
  expect(bytes[0]).toBe(1);
  expect(fab[0]).toBe(0);
  expect(bytes).not.toEqual(fab);
});
