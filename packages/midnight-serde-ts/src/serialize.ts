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

import type { CompactType, CompactUintType, CompactValue, CompactValueOf } from "./types.ts";
import { FIELD_MODULUS } from "./types.ts";
import { assertCompactType, assertUnreachable, isUint8Array } from "./validate.ts";

/**
 * Byte length of the largest legal value, given the EXCLUSIVE bound. 0 for a bound of 1.
 *
 * @param bound - Exclusive upper bound of the value range.
 * @returns The byte width needed to hold any value below the bound.
 */
function widthOfBound(bound: bigint): number {
  let max = bound - 1n;
  let width = 0;
  while (max > 0n) {
    width++;
    max >>= 8n;
  }
  return width;
}

/**
 * The sized-form bit width of a uint descriptor, or undefined for the bounded
 * form. Own-property read: `'bits' in type` would walk the prototype chain.
 *
 * @param type - The uint descriptor to inspect.
 * @returns The declared bit width, or undefined when the descriptor is bounded.
 */
function sizedBits(type: CompactUintType): number | undefined {
  return Object.hasOwn(type, "bits") ? (type as { bits?: number }).bits : undefined;
}

/**
 * The EXCLUSIVE upper bound of a uint descriptor, whichever form it uses.
 *
 * @param type - The uint descriptor to read.
 * @returns One past the largest value the descriptor admits.
 */
export function uintBound(type: CompactUintType): bigint {
  const bits = sizedBits(type);
  return bits !== undefined
    ? 1n << BigInt(bits)
    : BigInt((type as { bound: number | bigint }).bound);
}

/**
 * Guard for the Number arithmetic below: element counts and widths are
 * individually safe integers (validated), but their products and sums can
 * still leave the safe range and silently round. Never produce a wrong size.
 *
 * @param size - The computed packed size to check.
 * @param label - Descriptor kind, used in the error message.
 * @returns The size unchanged, once proven safe.
 * @throws {Error} If the size is not a safe integer.
 */
function assertSafeSize(size: number, label: string): number {
  if (!Number.isSafeInteger(size)) {
    throw new Error(`${label}: packed size exceeds Number.MAX_SAFE_INTEGER`);
  }
  return size;
}

/**
 * Packed byte size of an ALREADY-VALIDATED descriptor. Package-internal: the
 * public {@link compactSerializedSize} validates first.
 *
 * @param type - A descriptor that has already passed validation.
 * @returns The packed byte size.
 */
export function packedSize(type: CompactType): number {
  switch (type.kind) {
    case "boolean":
      return 1;
    case "uint":
      return widthOfBound(uintBound(type));
    case "field":
      return 32;
    case "bytes":
      return type.length;
    case "enum":
      return widthOfBound(BigInt(type.variants));
    case "vector":
      return assertSafeSize(type.length * packedSize(type.element), "vector");
    case "tuple":
      return assertSafeSize(
        type.elements.reduce((sum, e) => sum + packedSize(e), 0),
        "tuple",
      );
    case "struct":
      return assertSafeSize(
        type.fields.reduce((sum, f) => sum + packedSize(f.type), 0),
        "struct",
      );
    default:
      return assertUnreachable(type, "packedSize");
  }
}

/**
 * Packed byte size of a type, before `serialize<T, N>`'s right zero-padding.
 *
 * @param type - The descriptor to size.
 * @returns The packed byte size.
 * @throws {Error} If the descriptor is not a well-formed Compact type.
 */
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
 *
 * @param type - The descriptor the value conforms to.
 * @param value - The value to pack, shaped by the descriptor.
 * @param padTo - Total output length; omit to return the value unpadded.
 * @returns The packed bytes.
 * @throws {Error} If the descriptor or the value fails validation, or `padTo` is
 *   smaller than the packed size.
 */
export function compactSerialize<const T extends CompactType>(
  type: T,
  value: CompactValueOf<T>,
  padTo?: number,
): Uint8Array {
  assertCompactType(type);
  if (padTo !== undefined && (!Number.isInteger(padTo) || padTo < 0)) {
    throw new Error(`padTo must be a non-negative integer, got ${String(padTo)}`);
  }
  const size = packedSize(type);
  const total = padTo ?? size;
  if (total < size) {
    throw new Error(
      `padTo ${String(total)} is below the packed size ${String(size)} (a compile error in Compact too)`,
    );
  }
  const out = new Uint8Array(total);
  encodeInto(out, 0, type, value, "value");
  return out;
}

/**
 * Whether a value is a plain object usable as a struct: not null, not an
 * array, not a Uint8Array. Takes `unknown` so each check is load-bearing
 * rather than narrowed away by the declared parameter type.
 *
 * @param value - The candidate struct value.
 * @returns Whether the value can carry named fields.
 */
function isStructValue(value: unknown): value is Record<string, CompactValue> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !isUint8Array(value)
  );
}

function encodeInto(
  out: Uint8Array,
  offset: number,
  type: CompactType,
  value: CompactValue,
  label: string,
): number {
  switch (type.kind) {
    case "boolean": {
      if (typeof value !== "boolean") throw new Error(`${label}: expected boolean`);
      out[offset] = value ? 1 : 0;
      return offset + 1;
    }
    case "uint": {
      if (typeof value !== "bigint") throw new Error(`${label}: expected bigint`);
      const bound = uintBound(type);
      const size = widthOfBound(bound);
      if (value >= bound) {
        throw new Error(`${label}: value ${String(value)} exceeds ${uintName(type)}`);
      }
      writeUintLE(out, offset, value, size, label);
      return offset + size;
    }
    case "field": {
      if (typeof value !== "bigint") throw new Error(`${label}: expected bigint`);
      if (value >= FIELD_MODULUS) {
        throw new Error(`${label}: value ${String(value)} is not below the Field modulus`);
      }
      writeUintLE(out, offset, value, 32, label);
      return offset + 32;
    }
    case "bytes": {
      if (!isUint8Array(value)) throw new Error(`${label}: expected Uint8Array`);
      if (value.length !== type.length) {
        throw new Error(
          `${label}: expected exactly ${String(type.length)} bytes, got ${String(value.length)}`,
        );
      }
      out.set(value, offset);
      return offset + type.length;
    }
    case "enum": {
      // Matches the generated bindings: enum values are numbers (the index).
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error(`${label}: expected an integer number (enum variant index)`);
      }
      const size = widthOfBound(BigInt(type.variants));
      if (value < 0 || value >= type.variants) {
        throw new Error(
          `${label}: variant index ${String(value)} is outside 0..${String(type.variants - 1)}`,
        );
      }
      writeUintLE(out, offset, BigInt(value), size, label);
      return offset + size;
    }
    case "vector": {
      if (!Array.isArray(value)) throw new Error(`${label}: expected array`);
      if (value.length !== type.length) {
        throw new Error(
          `${label}: expected exactly ${String(type.length)} elements, got ${String(value.length)}`,
        );
      }
      let cursor = offset;
      value.forEach((element, i) => {
        cursor = encodeInto(out, cursor, type.element, element, `${label}[${String(i)}]`);
      });
      return cursor;
    }
    case "tuple": {
      if (!Array.isArray(value)) throw new Error(`${label}: expected array (tuple)`);
      if (value.length !== type.elements.length) {
        throw new Error(
          `${label}: expected exactly ${String(type.elements.length)} elements, got ${String(value.length)}`,
        );
      }
      let cursor = offset;
      for (const [i, element] of type.elements.entries()) {
        const item = value[i];
        // The length check above proves this, but the index signature does not.
        if (item === undefined) {
          throw new Error(`${label}[${String(i)}]: missing element`);
        }
        cursor = encodeInto(out, cursor, element, item, `${label}[${String(i)}]`);
      }
      return cursor;
    }
    case "struct": {
      if (!isStructValue(value)) {
        throw new Error(`${label}: expected an object`);
      }
      // Reject unknown keys, mirroring the strictness on descriptors: a
      // typo'd extra property alongside the correctly-named ones would
      // otherwise vanish silently.
      const declared = new Set(type.fields.map((f) => f.name));
      for (const key of Object.keys(value)) {
        if (!declared.has(key)) {
          throw new Error(`${label}: unknown field '${key}' (not in the descriptor)`);
        }
      }
      let cursor = offset;
      for (const field of type.fields) {
        // Own-property lookup: field names like 'toString' or '__proto__'
        // are legal Compact identifiers and must not resolve through the
        // JS prototype chain.
        if (!Object.hasOwn(value, field.name)) {
          throw new Error(`${label}: missing field '${field.name}'`);
        }
        const fieldValue = value[field.name];
        // hasOwn above proves the KEY exists; an explicit undefined VALUE is a
        // separate case, and neither is serializable.
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

/**
 * Display name of a uint descriptor in its own declaration form.
 *
 * @param type - The uint descriptor to name.
 * @returns `Uint<bits>` for the sized form, `Uint<0..bound>` for the bounded one.
 */
export function uintName(type: CompactUintType): string {
  const bits = sizedBits(type);
  return bits !== undefined
    ? `Uint<${String(bits)}>`
    : `Uint<0..${String((type as { bound: number | bigint }).bound)}>`;
}

function writeUintLE(
  out: Uint8Array,
  offset: number,
  value: bigint,
  size: number,
  label: string,
): void {
  if (value < 0n) {
    throw new Error(
      `${label}: negative values cannot be Compact-serialized (got ${String(value)})`,
    );
  }
  if (value >> BigInt(size * 8) !== 0n) {
    throw new Error(`${label}: value ${String(value)} does not fit in ${String(size)} bytes`);
  }
  let v = value;
  for (let i = 0; i < size; i++) {
    out[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}
