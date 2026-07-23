// Byte-exact twin of Compact's builtin `deserialize<T, N>` from
// CompactStandardLibrary, pinned against compiled circuits by tests/.
//
// One deliberate difference from the circuit: the circuit IGNORES bytes in the
// padding region entirely (verified empirically), while this decoder rejects
// non-zero padding by default. Zero padding is what `serialize<T, N>` writes,
// so garbage there means a corrupt or mis-framed buffer, and failing loudly
// off-chain is the safer default. Pass `{ ignorePadding: true }` to mirror the
// circuit exactly.
//
// Compact is a strict protocol, so this module is too: the descriptor is
// fully validated (src/validate.ts) and the input buffer type-checked before
// any decoding, every decoded value is range-checked (booleans above 1,
// out-of-range Uint and Field encodings all throw), and every switch has a
// throwing backstop for anything that slips past the type system.

import { FIELD_MODULUS } from './types.ts';
import type { CompactType, CompactValue, CompactValueOf } from './types.ts';
import { packedSize } from './serialize.ts';
import { assertCompactType, assertUnreachable } from './validate.ts';

export interface CompactDeserializeOptions {
  /** Skip the all-zero check on bytes after the packed value (circuit behaviour). */
  ignorePadding?: boolean;
}

/**
 * Inverse of `compactSerialize`: decode the packed prefix of `bytes`.
 *
 * The return type is derived from the descriptor (see `CompactValueOf`), so a
 * literal descriptor yields a fully typed value with no cast at the call site.
 */
export function compactDeserialize<const T extends CompactType>(
  type: T,
  bytes: Uint8Array,
  options: CompactDeserializeOptions = {}
): CompactValueOf<T> {
  assertCompactType(type);
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('bytes must be a Uint8Array');
  }
  const [value, consumed] = decodeFrom(bytes, 0, type, 'value');
  if (!options.ignorePadding) {
    for (let i = consumed; i < bytes.length; i++) {
      if (bytes[i] !== 0) {
        throw new Error(
          `non-zero padding byte 0x${bytes[i]!.toString(16)} at offset ${i} ` +
            `(pass ignorePadding to mirror the circuit, which reads only the packed prefix)`
        );
      }
    }
  }
  return value as CompactValueOf<T>;
}

function decodeFrom(
  bytes: Uint8Array,
  offset: number,
  type: CompactType,
  label: string
): [CompactValue, number] {
  const need = packedSize(type);
  if (offset + need > bytes.length) {
    throw new Error(
      `${label}: needs ${need} bytes at offset ${offset}, buffer has ${bytes.length}`
    );
  }
  switch (type.kind) {
    case 'boolean': {
      const b = bytes[offset]!;
      if (b > 1) throw new Error(`${label}: invalid boolean byte 0x${b.toString(16)}`);
      return [b === 1, offset + 1];
    }
    case 'uint': {
      const size = packedSize(type);
      const value = readUintLE(bytes, offset, size);
      // Only reachable for widths that are not byte-aligned (a byte-aligned
      // width fills its bytes exactly). Mirrors Compact's run-time Uint range
      // checks; not circuit-pinned since the fixtures use aligned widths.
      if (value >= 1n << BigInt(type.bits)) {
        throw new Error(`${label}: encoding ${value} exceeds Uint<${type.bits}>`);
      }
      return [value, offset + size];
    }
    case 'field': {
      const value = readUintLE(bytes, offset, 32);
      // The circuit rejects out-of-range Field encodings at runtime too
      // (verified empirically): mirror it.
      if (value >= FIELD_MODULUS) {
        throw new Error(`${label}: encoding ${value} is not below the Field modulus`);
      }
      return [value, offset + 32];
    }
    case 'bytes':
      return [bytes.slice(offset, offset + type.length), offset + type.length];
    case 'vector': {
      const elements: CompactValue[] = [];
      let cursor = offset;
      for (let i = 0; i < type.length; i++) {
        const [element, next] = decodeFrom(bytes, cursor, type.element, `${label}[${i}]`);
        elements.push(element);
        cursor = next;
      }
      return [elements, cursor];
    }
    case 'struct': {
      const value: { [field: string]: CompactValue } = {};
      let cursor = offset;
      for (const field of type.fields) {
        const [fieldValue, next] = decodeFrom(bytes, cursor, field.type, `${label}.${field.name}`);
        value[field.name] = fieldValue;
        cursor = next;
      }
      return [value, cursor];
    }
    default:
      return assertUnreachable(type, label);
  }
}

function readUintLE(bytes: Uint8Array, offset: number, size: number): bigint {
  let v = 0n;
  for (let i = size - 1; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[offset + i]!);
  }
  return v;
}
