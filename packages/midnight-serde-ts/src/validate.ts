// Strict runtime validation of CompactType descriptors. TypeScript checks
// descriptors at compile time, but descriptors can also arrive from plain JS,
// JSON, or casts, and Compact is a strict protocol: a malformed descriptor
// must throw immediately with a path to the offending node, never produce
// bytes. Every public entry point of this package validates its descriptor
// through here before doing any work.

import type { CompactType } from "./types.ts";
import { MAX_UINT_BITS, MAX_UINT_BOUND } from "./types.ts";

/** The exact keys allowed on each descriptor kind: extra keys are rejected. */
const KIND_KEYS: Record<string, readonly string[]> = {
  boolean: ["kind"],
  uint: ["kind", "bits", "bound"],
  field: ["kind"],
  bytes: ["kind", "length"],
  enum: ["kind", "variants"],
  vector: ["kind", "length", "element"],
  tuple: ["kind", "elements"],
  struct: ["kind", "fields"],
};

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  // isSafeInteger, not isInteger: a length like 2^60 passes isInteger but
  // breaks the Number arithmetic packed sizes are computed with.
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer, got ${String(value)}`);
  }
}

/**
 * Cross-realm-safe Uint8Array check. `instanceof` fails for buffers created
 * in another realm (node:vm context, iframe), which are otherwise perfectly
 * valid inputs, so fall back to the brand check.
 *
 * @param value - The value to test.
 * @returns Whether the value is a Uint8Array from any realm.
 */
export function isUint8Array(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array || Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

/**
 * Assert that `type` is a structurally valid {@link CompactType}, recursively.
 * Rejects unknown kinds, unexpected extra keys (typo protection), out-of-range
 * widths and lengths, empty or duplicate struct field names, and any
 * non-object node. Error messages carry the path to the offending node.
 *
 * @param type - The candidate descriptor.
 * @param label - Path prefix for error messages.
 * @throws {Error} If the descriptor is malformed at any depth.
 */
export function assertCompactType(type: unknown, label = "type"): asserts type is CompactType {
  if (typeof type !== "object" || type === null || Array.isArray(type)) {
    throw new Error(`${label}: descriptor must be a plain object`);
  }
  const record = type as Record<string, unknown>;
  const kind = record.kind;
  // Object.hasOwn, not `in`: `in` walks the prototype chain, so kinds like
  // 'toString' would slip past and die later with a confusing TypeError.
  const allowedKeys = typeof kind === "string" ? KIND_KEYS[kind] : undefined;
  if (typeof kind !== "string" || !Object.hasOwn(KIND_KEYS, kind) || allowedKeys === undefined) {
    throw new Error(
      `${label}: unknown descriptor kind ${JSON.stringify(kind)} ` +
        `(expected 'boolean' | 'uint' | 'field' | 'bytes' | 'enum' | 'vector' | 'tuple' | 'struct')`,
    );
  }
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`${label}: unexpected key '${key}' on a '${kind}' descriptor`);
    }
  }

  switch (kind) {
    case "boolean":
    case "field":
      return;

    case "uint": {
      // Own-property reads: a plain `record.bits` would resolve through the
      // prototype chain, letting `{ __proto__: { bits: 8 }, kind: 'uint' }`
      // slip past even though Object.keys sees no such key.
      const bits = Object.hasOwn(record, "bits") ? record.bits : undefined;
      const bound = Object.hasOwn(record, "bound") ? record.bound : undefined;
      const hasBits = bits !== undefined;
      const hasBound = bound !== undefined;
      if (hasBits === hasBound) {
        throw new Error(
          `${label}: a uint descriptor needs exactly one of 'bits' (sized Uint<w>) ` +
            `or 'bound' (bounded Uint<0..n>)`,
        );
      }
      if (hasBits) {
        if (
          typeof bits !== "number" ||
          !Number.isInteger(bits) ||
          bits < 1 ||
          bits > MAX_UINT_BITS
        ) {
          throw new Error(
            `${label}: uint bits must be an integer in 1..${String(MAX_UINT_BITS)}, got ${JSON.stringify(bits)}`,
          );
        }
        return;
      }
      if (typeof bound === "number" && !Number.isSafeInteger(bound)) {
        throw new Error(
          `${label}: a number uint bound must be a safe integer (use a bigint ` +
            `beyond 2^53), got ${String(bound)}`,
        );
      }
      if (typeof bound !== "number" && typeof bound !== "bigint") {
        throw new Error(`${label}: uint bound must be a number or bigint, got ${String(bound)}`);
      }
      if (BigInt(bound) < 1n || BigInt(bound) > MAX_UINT_BOUND) {
        throw new Error(
          `${label}: uint bound must be in 1..2^248 (the bound is EXCLUSIVE, ` +
            `matching Uint<0..n>), got ${String(bound)}`,
        );
      }
      return;
    }

    case "bytes":
      assertNonNegativeInteger(record.length, `${label}: bytes length`);
      return;

    case "enum": {
      const variants = record.variants;
      if (typeof variants !== "number" || !Number.isSafeInteger(variants) || variants < 1) {
        throw new Error(
          `${label}: enum variants must be a positive integer, got ${String(variants)}`,
        );
      }
      return;
    }

    case "vector":
      assertNonNegativeInteger(record.length, `${label}: vector length`);
      assertCompactType(record.element, `${label}.element`);
      return;

    case "tuple": {
      const elements = record.elements;
      if (!Array.isArray(elements)) {
        throw new Error(`${label}: tuple elements must be an array`);
      }
      elements.forEach((element: unknown, i) => {
        assertCompactType(element, `${label}.elements[${String(i)}]`);
      });
      return;
    }

    case "struct": {
      const fields = record.fields;
      if (!Array.isArray(fields)) {
        throw new Error(`${label}: struct fields must be an array`);
      }
      const seen = new Set<string>();
      fields.forEach((field: unknown, i) => {
        const fieldLabel = `${label}.fields[${String(i)}]`;
        if (typeof field !== "object" || field === null || Array.isArray(field)) {
          throw new Error(`${fieldLabel}: field must be a plain object`);
        }
        const fieldRecord = field as Record<string, unknown>;
        for (const key of Object.keys(fieldRecord)) {
          if (key !== "name" && key !== "type") {
            throw new Error(`${fieldLabel}: unexpected key '${key}' on a struct field`);
          }
        }
        if (typeof fieldRecord.name !== "string" || fieldRecord.name.length === 0) {
          throw new Error(`${fieldLabel}: field name must be a non-empty string`);
        }
        if (seen.has(fieldRecord.name)) {
          throw new Error(`${fieldLabel}: duplicate field name '${fieldRecord.name}'`);
        }
        seen.add(fieldRecord.name);
        assertCompactType(fieldRecord.type, `${fieldLabel}.type`);
      });
      return;
    }
  }
}

/**
 * Boolean form of {@link assertCompactType}.
 *
 * @param type - The candidate descriptor.
 * @returns Whether the descriptor is structurally valid.
 */
export function isCompactType(type: unknown): type is CompactType {
  try {
    assertCompactType(type);
    return true;
  } catch {
    return false;
  }
}

/**
 * Exhaustiveness backstop for descriptor switches. Statically `value` is
 * `never` (every kind handled); at runtime it still throws on anything that
 * slipped past validation instead of falling through to undefined behaviour.
 *
 * @param value - The descriptor every branch was meant to have handled.
 * @param label - Caller name, used in the error message.
 * @throws {Error} Always, naming the unhandled kind.
 */
export function assertUnreachable(value: never, label: string): never {
  const kind = (value as { kind?: unknown } | null)?.kind;
  throw new Error(`${label}: unhandled descriptor kind ${JSON.stringify(kind)}`);
}
