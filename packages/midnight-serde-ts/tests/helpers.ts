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

import type { CompactType, CompactValue } from "../src/index.ts";

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
