// Byte-exact twin of Compact's builtin `serialize<T, N>` from
// CompactStandardLibrary, pinned against compiled circuits by tests/.
//
// Layout rules (compactc 0.33 / language 0.25):
//   - struct fields and tuple elements are packed in declaration order, no
//     alignment gaps
//   - every value is little-endian at its NATURAL width (see src/types.ts);
//     bounded uints and enums are as wide as their largest legal value, which
//     makes `Uint<0..1>` and single-variant enums ZERO bytes wide
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
import type { CompactType, CompactUintType, CompactValue, CompactValueOf } from './types.ts';
import { assertCompactType, assertUnreachable } from './validate.ts';

/** Byte length of the largest legal value, given the EXCLUSIVE bound. 0 for a bound of 1. */
function widthOfBound(bound: bigint): number {
  let max = bound - 1n;
  let width = 0;
  while (max > 0n) {
    width++;
    max >>= 8n;
  }
  return width;
}

/** The EXCLUSIVE upper bound of a uint descriptor, whichever form it uses. */
export function uintBound(type: CompactUintType): bigint {
  return 'bits' in type && type.bits !== undefined
    ? 1n << BigInt(type.bits)
    : BigInt((type as { bound: number | bigint }).bound);
}

/**
 * Packed byte size of an ALREADY-VALIDATED descriptor. Package-internal: the
 * public {@link compactSerializedSize} validates first.
 */
export function packedSize(type: CompactType): number {
  switch (type.kind) {
    case 'boolean':
      return 1;
    case 'uint':
      return widthOfBound(uintBound(type));
    case 'field':
      return 32;
    case 'bytes':
      return type.length;
    case 'enum':
      return widthOfBound(BigInt(type.variants));
    case 'vector':
      return type.length * packedSize(type.element);
    case 'tuple':
      return type.elements.reduce((sum, e) => sum + packedSize(e), 0);
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
      const bound = uintBound(type);
      const size = widthOfBound(bound);
      if (value >= bound) {
        throw new Error(`${label}: value ${value} exceeds ${uintName(type)}`);
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
    case 'enum': {
      // Matches the generated bindings: enum values are numbers (the index).
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error(`${label}: expected an integer number (enum variant index)`);
      }
      const size = widthOfBound(BigInt(type.variants));
      if (value < 0 || value >= type.variants) {
        throw new Error(
          `${label}: variant index ${value} is outside 0..${type.variants - 1}`
        );
      }
      writeUintLE(out, offset, BigInt(value), size, label);
      return offset + size;
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
    case 'tuple': {
      if (!Array.isArray(value)) throw new Error(`${label}: expected array (tuple)`);
      if (value.length !== type.elements.length) {
        throw new Error(
          `${label}: expected exactly ${type.elements.length} elements, got ${value.length}`
        );
      }
      let cursor = offset;
      type.elements.forEach((element, i) => {
        cursor = encodeInto(out, cursor, element, value[i]!, `${label}[${i}]`);
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
        // Own-property lookup: field names like 'toString' or '__proto__'
        // are legal Compact identifiers and must not resolve through the
        // JS prototype chain.
        if (!Object.hasOwn(value, field.name)) {
          throw new Error(`${label}: missing field '${field.name}'`);
        }
        const fieldValue = (value as { [field: string]: CompactValue })[field.name]!;
        cursor = encodeInto(out, cursor, field.type, fieldValue, `${label}.${field.name}`);
      }
      return cursor;
    }
    default:
      return assertUnreachable(type, label);
  }
}

/** Display name of a uint descriptor in its own declaration form. */
export function uintName(type: CompactUintType): string {
  return 'bits' in type && type.bits !== undefined
    ? `Uint<${type.bits}>`
    : `Uint<0..${(type as { bound: number | bigint }).bound}>`;
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
