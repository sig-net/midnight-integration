import assert from "node:assert/strict";

import {
  type CompactType,
  type CompactValue,
  FIELD_MODULUS,
  SECP256K1_BASE_MODULUS,
  SECP256K1_SCALAR_MODULUS,
} from "@sig-net/midnight-serde";

import { jsonToType, jsonToValue, loadCorpus } from "./corpus.ts";
import { NESTED, SHAPES, VECTORS_DEEP } from "./descriptors.ts";
import { byteWidthOfMax } from "./oracle.ts";
import { mulberry32, randValue } from "./random.ts";

/** One generated circuit pair and the values checked against it. */
export interface CompilerCase {
  name: string;
  type: CompactType;
  values: CompactValue[];
  encode: boolean;
}

/**
 * Deterministic width, range and composite coverage for compiled circuits.
 *
 * @returns Cases generated independently of the codecs' size calculation.
 */
export function compilerCases(): CompilerCase[] {
  const cases: CompilerCase[] = [];
  const rng = mulberry32(0x19470624);
  const numerics: CompactType[] = Array.from({ length: 248 }, (_, i) => ({
    kind: "uint",
    bits: i + 1,
  }));
  const bounds = new Set([1n, 2n, 3n, 1000n, 70000n]);
  for (let bits = 8; bits <= 248; bits += 8) {
    for (const delta of [-1n, 0n, 1n]) {
      const bound = (1n << BigInt(bits)) + delta;
      if (bound <= 1n << 248n) bounds.add(bound);
    }
  }
  for (const bound of bounds) numerics.push({ kind: "uint", bound });
  numerics.push({ kind: "field" }, { kind: "secp256k1-base" }, { kind: "secp256k1-scalar" });
  for (const variants of [1, 2, 3, 255, 256, 257, 300]) numerics.push({ kind: "enum", variants });
  for (const type of numerics) {
    const bound = numericBound(type);
    const values: CompactValue[] = [0n, 1n % bound, bound - 1n, bound / 2n];
    if (type.kind === "enum") {
      for (let i = 0; i < values.length; i++) values[i] = Number(values[i]);
    }
    for (let i = 0; i < 8; i++) values.push(randValue(rng, type));
    cases.push({ name: `numeric-${String(cases.length)}`, type, values, encode: true });
  }
  cases.push({ name: "boolean", type: { kind: "boolean" }, values: [false, true], encode: true });
  for (const length of [0, 1, 7, 31, 32, 33, 64]) {
    cases.push({
      name: `bytes-${String(length)}`,
      type: { kind: "bytes", length },
      values: [new Uint8Array(length), new Uint8Array(length).fill(255)],
      encode: true,
    });
  }
  for (const [name, type, value] of SHAPES) {
    cases.push({
      name,
      type,
      values: [value, randValue(rng, type)],
      encode: type !== NESTED && type !== VECTORS_DEEP,
    });
  }
  for (const record of loadCorpus()) {
    if (record.record !== "sweep") continue;
    const type = jsonToType(record.type);
    cases.push({
      name: record.name,
      type,
      values: [jsonToValue(type, record.value), randValue(rng, type)],
      encode: false,
    });
  }
  return cases;
}

/**
 * Numeric upper bound used to generate boundary values and encodings.
 *
 * @param type - Numeric descriptor.
 * @returns Exclusive bound.
 * @throws {Error} If the descriptor is not numeric.
 */
export function numericBound(type: CompactType): bigint {
  switch (type.kind) {
    case "uint":
      return "bits" in type ? 1n << BigInt(type.bits) : BigInt(type.bound);
    case "field":
      return FIELD_MODULUS;
    case "secp256k1-base":
      return SECP256K1_BASE_MODULUS;
    case "secp256k1-scalar":
      return SECP256K1_SCALAR_MODULUS;
    case "enum":
      return BigInt(type.variants);
    default:
      throw new Error("Expected a numeric descriptor");
  }
}

/**
 * Emit Compact declarations and compute widths from type bounds.
 *
 * @param type - Descriptor to translate.
 * @param declarations - Struct and enum declarations appended in dependency order.
 * @returns Compact type syntax and its natural byte width.
 */
export function compactTypeSource(
  type: CompactType,
  declarations: string[],
): { name: string; width: number } {
  switch (type.kind) {
    case "boolean":
      return { name: "Boolean", width: 1 };
    case "field":
      return { name: "Field", width: 32 };
    case "secp256k1-base":
      return { name: "Secp256k1Base", width: 32 };
    case "secp256k1-scalar":
      return { name: "Secp256k1Scalar", width: 32 };
    case "uint":
      return {
        name: "bits" in type ? `Uint<${String(type.bits)}>` : `Uint<0..${String(type.bound)}>`,
        width: byteWidthOfMax(numericBound(type) - 1n),
      };
    case "bytes":
      return { name: `Bytes<${String(type.length)}>`, width: type.length };
    case "enum": {
      const name = `E${String(type.variants)}`;
      const declaration = `enum ${name} { ${Array.from({ length: type.variants }, (_, i) => `v${String(i)}`).join(", ")} }`;
      if (!declarations.includes(declaration)) declarations.push(declaration);
      return { name, width: byteWidthOfMax(BigInt(type.variants - 1)) };
    }
    case "vector": {
      const element = compactTypeSource(type.element, declarations);
      return {
        name: `Vector<${String(type.length)}, ${element.name}>`,
        width: type.length * element.width,
      };
    }
    case "tuple": {
      const elements = type.elements.map((e) => compactTypeSource(e, declarations));
      return {
        name: `[${elements.map((e) => e.name).join(", ")}]`,
        width: elements.reduce((sum, e) => sum + e.width, 0),
      };
    }
    case "struct": {
      const fields = type.fields.map((f) => ({
        field: f.name,
        ...compactTypeSource(f.type, declarations),
      }));
      const name = `S${String(declarations.length)}`;
      declarations.push(
        `struct ${name} { ${fields.map((f) => `${f.field}: ${f.name};`).join(" ")} }`,
      );
      return { name, width: fields.reduce((sum, f) => sum + f.width, 0) };
    }
  }
}

/**
 * Require every sized Uint width and non-empty value samples in the compiler sweep.
 *
 * @param cases - Generated compiler cases.
 * @throws {Error} If coverage is incomplete.
 */
export function assertCompilerCoverage(cases: CompilerCase[]): void {
  assert(cases.length > 700, "Compiler sweep lost type coverage");
  assert(
    cases.every((c) => c.values.length > 0),
    "Compiler case has no values",
  );
  for (let bits = 1; bits <= 248; bits++) {
    assert(
      cases.some(
        (c) => c.type.kind === "uint" && "bits" in c.type && c.type.bits === bits && c.encode,
      ),
      `Missing Uint<${String(bits)}> encoding coverage`,
    );
  }
}
