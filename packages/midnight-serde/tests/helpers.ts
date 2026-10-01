// Shared test plumbing: the hex printer and the toBinaryRepr oracle adapter.
//
// The adapter maps a twin descriptor onto @midnight-ntwrk/compact-runtime's
// CompactType classes so toBinaryRepr (test-only, never a runtime dependency)
// can serialize the same value. Two things make it a valuable second oracle:
// it was written by the Midnight team, and it can produce the layouts
// compactc cannot compile serialize<T, N> for (vectors of structs, deep
// struct nesting), pinning the twin's serialize side where no circuit exists.
// It returns the packed bytes with no padding.

import {
  type CompactType as RuntimeCompactType,
  CompactTypeBoolean,
  CompactTypeBytes,
  CompactTypeEnum,
  CompactTypeField,
  CompactTypeUnsignedInteger,
  CompactTypeVector,
  toBinaryRepr,
} from "@midnight-ntwrk/compact-runtime";

import { type CompactType, type CompactValue, FIELD_MODULUS } from "../src/index.ts";

export const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/**
 * Byte width of a maximum value, derived from its binary-string length. This
 * deliberately does NOT call the twin's own width computation: the runtime
 * classes take the byte width as a constructor argument, so feeding them the
 * twin's size would let a width bug propagate into BOTH sides of the oracle
 * comparison and pass unnoticed.
 */
export function byteWidthOfMax(max: bigint): number {
  return max === 0n ? 0 : Math.ceil(max.toString(2).length / 8);
}

/** toBinaryRepr over the runtime mirror of `type`: the second serialize oracle. */
export function oracleSerialize(type: CompactType, value: CompactValue): Uint8Array {
  return toBinaryRepr(runtimeType(type), value);
}

export function runtimeType(type: CompactType): RuntimeCompactType<unknown> {
  switch (type.kind) {
    case "boolean":
      return CompactTypeBoolean;
    case "field":
      return CompactTypeField;
    case "uint": {
      const bound =
        Object.hasOwn(type, "bits") && (type as { bits?: number }).bits !== undefined
          ? 1n << BigInt((type as { bits: number }).bits)
          : BigInt((type as { bound: number | bigint }).bound);
      return new CompactTypeUnsignedInteger(bound - 1n, byteWidthOfMax(bound - 1n));
    }
    case "enum":
      return new CompactTypeEnum(type.variants - 1, byteWidthOfMax(BigInt(type.variants - 1)));
    case "bytes":
      return new CompactTypeBytes(type.length);
    case "vector":
      return new CompactTypeVector(type.length, runtimeType(type.element));
    case "tuple": {
      const elements = type.elements.map(runtimeType);
      return composite(elements, (value) => value as unknown[]);
    }
    case "struct": {
      const elements = type.fields.map((f) => runtimeType(f.type));
      return composite(elements, (value) =>
        type.fields.map((f) => (value as Record<string, unknown>)[f.name]),
      );
    }
  }
}

// Structs and tuples have no runtime class: compiled contracts emit ad-hoc
// descriptor objects that concatenate their members' alignments and values,
// and this mirrors that pattern.
function composite(
  elements: RuntimeCompactType<unknown>[],
  split: (value: unknown) => unknown[],
): RuntimeCompactType<unknown> {
  return {
    alignment: () => elements.flatMap((e) => e.alignment() as unknown[]),
    toValue: (value: unknown) => {
      const parts = split(value);
      return elements.flatMap((e, i) => e.toValue(parts[i]) as unknown[]);
    },
    fromValue: () => {
      throw new Error("oracle helper is serialize-only");
    },
  } as unknown as RuntimeCompactType<unknown>;
}

// ---- seeded random generation, shared by property.test.ts and borsh.test.ts

// mulberry32: tiny, deterministic, good enough distribution for test-case
// generation.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

/** Uniform-ish integer in [min, max], inclusive. */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** A bigint in [0, bound), biased towards the boundaries (where bugs live). */
export function randBigIntBelow(rng: Rng, bound: bigint): bigint {
  if (bound <= 1n) return 0n;
  const roll = rng();
  if (roll < 0.15) return 0n;
  if (roll < 0.3) return bound - 1n;
  let v = 0n;
  const bytes = (bound - 1n).toString(16).length / 2 + 1;
  for (let i = 0; i < bytes; i++) {
    v = (v << 8n) | BigInt(randInt(rng, 0, 255));
  }
  return v % bound;
}

/** A random in-range value for any descriptor, boundary-biased via randBigIntBelow. */
export function randValue(rng: Rng, type: CompactType): CompactValue {
  switch (type.kind) {
    case "boolean":
      return rng() < 0.5;
    case "field":
      return randBigIntBelow(rng, FIELD_MODULUS);
    case "uint": {
      const bound =
        "bits" in type
          ? 1n << BigInt(type.bits)
          : BigInt((type as { bound: number | bigint }).bound);
      return randBigIntBelow(rng, bound);
    }
    case "bytes":
      return Uint8Array.from({ length: type.length }, () => randInt(rng, 0, 255));
    case "enum":
      return randInt(rng, 0, type.variants - 1);
    case "vector":
      return Array.from({ length: type.length }, () => randValue(rng, type.element));
    case "tuple":
      return type.elements.map((e) => randValue(rng, e));
    case "struct": {
      const value: Record<string, CompactValue> = {};
      for (const field of type.fields) value[field.name] = randValue(rng, field.type);
      return value;
    }
  }
}
