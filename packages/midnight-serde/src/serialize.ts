// Byte-exact twin of Compact's builtin `serialize<T, N>` from
// CompactStandardLibrary, pinned against compiled circuits by tests/.
//
// Layout rules (compactc 0.33 / language 0.25):
//   - struct fields are packed in declaration order, no alignment gaps
//   - every value is little-endian at its NATURAL width (see src/types.ts)
//   - `serialize<T, N>` places the packed value at the START of `Bytes<N>` and
//     zero-pads on the right; N below the packed size is a compile error, and
//     this module throws on the same condition.
//
// Compact is a strict protocol, so this module is too: every public entry
// point runs the full recursive descriptor validation (src/validate.ts)
// before touching a byte, every value is range- and shape-checked at runtime,
// and every switch has a throwing backstop for anything that slips past the
// type system.

import { FIELD_MODULUS } from './types.ts';
import type { CompactType, CompactValue, CompactValueOf } from './types.ts';
import { assertCompactType, assertUnreachable } from './validate.ts';

/**
 * Packed byte size of an ALREADY-VALIDATED descriptor. Package-internal: the
 * public {@link compactSerializedSize} validates first.
 */
export function packedSize(type: CompactType): number {
  switch (type.kind) {
    case 'boolean':
      return 1;
    case 'uint':
      return Math.ceil(type.bits / 8);
    case 'field':
      return 32;
    case 'bytes':
      return type.length;
    case 'vector':
      return type.length * packedSize(type.element);
    case 'struct':
      return type.fields.reduce((sum, f) => sum + packedSize(f.type), 0);
    default:
      return assertUnreachable(type, 'packedSize');
  }
}

/** Packed byte size of a type, before `serialize<T, N>`'s right zero-padding. */
export function compactSerializedSize(type: CompactType): number {
  assertCompactType(type);
  return packedSize(type);
}

/**
 * Byte-exact twin of `serialize<T, padTo>(value)`. With `padTo` omitted the
 * packed value is returned unpadded, matching `serialize<T, packedSize>`.
 *
 * The value parameter is typed from the descriptor (see `CompactValueOf`), so
 * a literal descriptor gets compile-time checking of the value shape, and the
 * same shape is enforced again at runtime.
 */
export function compactSerialize<const T extends CompactType>(
  type: T,
  value: CompactValueOf<T>,
  padTo?: number
): Uint8Array {
  assertCompactType(type);
  if (padTo !== undefined && (!Number.isInteger(padTo) || padTo < 0)) {
    throw new Error(`padTo must be a non-negative integer, got ${String(padTo)}`);
  }
  const size = packedSize(type);
  const total = padTo ?? size;
  if (total < size) {
    throw new Error(
      `padTo ${total} is below the packed size ${size} (a compile error in Compact too)`
    );
  }
  const out = new Uint8Array(total);
  encodeInto(out, 0, type, value as CompactValue, 'value');
  return out;
}

function encodeInto(
  out: Uint8Array,
  offset: number,
  type: CompactType,
  value: CompactValue,
  label: string
): number {
  switch (type.kind) {
    case 'boolean': {
      if (typeof value !== 'boolean') throw new Error(`${label}: expected boolean`);
      out[offset] = value ? 1 : 0;
      return offset + 1;
    }
    case 'uint': {
      if (typeof value !== 'bigint') throw new Error(`${label}: expected bigint`);
      const size = packedSize(type);
      if (value >= 1n << BigInt(type.bits)) {
        throw new Error(`${label}: value ${value} exceeds Uint<${type.bits}>`);
      }
      writeUintLE(out, offset, value, size, label);
      return offset + size;
    }
    case 'field': {
      if (typeof value !== 'bigint') throw new Error(`${label}: expected bigint`);
      if (value >= FIELD_MODULUS) {
        throw new Error(`${label}: value ${value} is not below the Field modulus`);
      }
      writeUintLE(out, offset, value, 32, label);
      return offset + 32;
    }
    case 'bytes': {
      if (!(value instanceof Uint8Array)) throw new Error(`${label}: expected Uint8Array`);
      if (value.length !== type.length) {
        throw new Error(
          `${label}: expected exactly ${type.length} bytes, got ${value.length}`
        );
      }
      out.set(value, offset);
      return offset + type.length;
    }
    case 'vector': {
      if (!Array.isArray(value)) throw new Error(`${label}: expected array`);
      if (value.length !== type.length) {
        throw new Error(
          `${label}: expected exactly ${type.length} elements, got ${value.length}`
        );
      }
      let cursor = offset;
      value.forEach((element, i) => {
        cursor = encodeInto(out, cursor, type.element, element, `${label}[${i}]`);
      });
      return cursor;
    }
    case 'struct': {
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        value instanceof Uint8Array
      ) {
        throw new Error(`${label}: expected an object`);
      }
      let cursor = offset;
      for (const field of type.fields) {
        const fieldValue = (value as { [field: string]: CompactValue })[field.name];
        if (fieldValue === undefined) {
          throw new Error(`${label}: missing field '${field.name}'`);
        }
        cursor = encodeInto(out, cursor, field.type, fieldValue, `${label}.${field.name}`);
      }
      return cursor;
    }
    default:
      return assertUnreachable(type, label);
  }
}

function writeUintLE(
  out: Uint8Array,
  offset: number,
  value: bigint,
  size: number,
  label: string
): void {
  if (value < 0n) {
    throw new Error(
      `${label}: negative values cannot be Compact-serialized (got ${value})`
    );
  }
  if (value >> BigInt(size * 8) !== 0n) {
    throw new Error(`${label}: value ${value} does not fit in ${size} bytes`);
  }
  let v = value;
  for (let i = 0; i < size; i++) {
    out[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}
