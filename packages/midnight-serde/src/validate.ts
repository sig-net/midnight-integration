// Strict runtime validation of CompactType descriptors. TypeScript checks
// descriptors at compile time, but descriptors can also arrive from plain JS,
// JSON, or casts, and Compact is a strict protocol: a malformed descriptor
// must throw immediately with a path to the offending node, never produce
// bytes. Every public entry point of this package validates its descriptor
// through here before doing any work.

import type { CompactType } from './types.ts';
import { MAX_UINT_BITS } from './types.ts';

/** The exact keys allowed on each descriptor kind: extra keys are rejected. */
const KIND_KEYS: Record<string, readonly string[]> = {
  boolean: ['kind'],
  uint: ['kind', 'bits'],
  field: ['kind'],
  bytes: ['kind', 'length'],
  vector: ['kind', 'length', 'element'],
  struct: ['kind', 'fields'],
};

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer, got ${String(value)}`);
  }
}

/**
 * Assert that `type` is a structurally valid {@link CompactType}, recursively.
 * Rejects unknown kinds, unexpected extra keys (typo protection), out-of-range
 * widths and lengths, empty or duplicate struct field names, and any
 * non-object node. Error messages carry the path to the offending node.
 */
export function assertCompactType(
  type: unknown,
  label = 'type'
): asserts type is CompactType {
  if (typeof type !== 'object' || type === null || Array.isArray(type)) {
    throw new Error(`${label}: descriptor must be a plain object`);
  }
  const record = type as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== 'string' || !(kind in KIND_KEYS)) {
    throw new Error(
      `${label}: unknown descriptor kind ${JSON.stringify(kind)} ` +
        `(expected 'boolean' | 'uint' | 'field' | 'bytes' | 'vector' | 'struct')`
    );
  }
  for (const key of Object.keys(record)) {
    if (!KIND_KEYS[kind]!.includes(key)) {
      throw new Error(`${label}: unexpected key '${key}' on a '${kind}' descriptor`);
    }
  }

  switch (kind) {
    case 'boolean':
    case 'field':
      return;

    case 'uint': {
      const bits = record.bits;
      if (
        typeof bits !== 'number' ||
        !Number.isInteger(bits) ||
        bits < 1 ||
        bits > MAX_UINT_BITS
      ) {
        throw new Error(
          `${label}: uint bits must be an integer in 1..${MAX_UINT_BITS}, got ${String(bits)}`
        );
      }
      return;
    }

    case 'bytes':
      assertPositiveInteger(record.length, `${label}: bytes length`);
      return;

    case 'vector':
      assertPositiveInteger(record.length, `${label}: vector length`);
      assertCompactType(record.element, `${label}.element`);
      return;

    case 'struct': {
      const fields = record.fields;
      if (!Array.isArray(fields) || fields.length === 0) {
        throw new Error(`${label}: struct fields must be a non-empty array`);
      }
      const seen = new Set<string>();
      fields.forEach((field: unknown, i) => {
        const fieldLabel = `${label}.fields[${i}]`;
        if (typeof field !== 'object' || field === null || Array.isArray(field)) {
          throw new Error(`${fieldLabel}: field must be a plain object`);
        }
        const fieldRecord = field as Record<string, unknown>;
        for (const key of Object.keys(fieldRecord)) {
          if (key !== 'name' && key !== 'type') {
            throw new Error(`${fieldLabel}: unexpected key '${key}' on a struct field`);
          }
        }
        if (typeof fieldRecord.name !== 'string' || fieldRecord.name.length === 0) {
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

/** Boolean form of {@link assertCompactType}. */
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
 */
export function assertUnreachable(value: never, label: string): never {
  const kind = (value as { kind?: unknown } | null)?.kind;
  throw new Error(`${label}: unhandled descriptor kind ${JSON.stringify(kind)}`);
}
