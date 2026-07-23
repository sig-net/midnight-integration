// Byte-exact twin of Compact's builtin `deserialize<T, N>` from
// CompactStandardLibrary, pinned against compiled circuits by tests/.
//
// Two deliberate divergences from the circuit, both strict-by-default
// (garbage in a buffer means corruption or mis-framing, and failing loudly
// off-chain is the safer default):
//   - PADDING: the circuit IGNORES bytes in the padding region entirely
//     (pinned by tests), while this decoder rejects non-zero padding. Pass
//     `{ ignorePadding: true }` to mirror the circuit.
//   - BOOLEANS: the circuit decodes ANY byte other than 0x01 as false, so
//     0x02..0xff all quietly become false (pinned by tests), while this
//     decoder rejects bytes above 1.
// Circuit-produced bytes never trigger either divergence: `serialize<T, N>`
// only writes zero padding and 0x00/0x01 booleans.
//
// Everything else mirrors the circuit exactly, including its rejections: the
// descriptor is fully validated (src/validate.ts) and the input buffer
// type-checked before any decoding, and out-of-range Uint, enum and Field
// encodings all throw exactly where the circuit throws (pinned by tests).

import { FIELD_MODULUS } from './types.ts';
import type { CompactType, CompactValue, CompactValueOf } from './types.ts';
import { packedSize, uintBound, uintName } from './serialize.ts';
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
      // Stricter than the circuit, which decodes any byte != 0x01 as false
      // (see the header comment).
      if (b > 1) throw new Error(`${label}: invalid boolean byte 0x${b.toString(16)}`);
      return [b === 1, offset + 1];
    }
    case 'uint': {
      const bound = uintBound(type);
      const size = packedSize(type);
      const value = readUintLE(bytes, offset, size);
      // Mirrors the circuit, which rejects encodings at or above the bound
      // (pinned by tests via the bounded fixture; only reachable for sized
      // uints when the width is not byte-aligned).
      if (value >= bound) {
        throw new Error(`${label}: encoding ${value} exceeds ${uintName(type)}`);
      }
      return [value, offset + size];
    }
    case 'field': {
      const value = readUintLE(bytes, offset, 32);
      // The circuit rejects out-of-range Field encodings at runtime too
      // (pinned by tests): mirror it.
      if (value >= FIELD_MODULUS) {
        throw new Error(`${label}: encoding ${value} is not below the Field modulus`);
      }
      return [value, offset + 32];
    }
    case 'bytes':
      return [bytes.slice(offset, offset + type.length), offset + type.length];
    case 'enum': {
      const size = packedSize(type);
      const value = readUintLE(bytes, offset, size);
      // Mirrors the circuit's variant-index range check (pinned by tests).
      if (value >= BigInt(type.variants)) {
        throw new Error(
          `${label}: encoding ${value} exceeds the last variant index ${type.variants - 1}`
        );
      }
      return [Number(value), offset + size];
    }
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
    case 'tuple': {
      const elements: CompactValue[] = [];
      let cursor = offset;
      type.elements.forEach((element, i) => {
        const [decoded, next] = decodeFrom(bytes, cursor, element, `${label}[${i}]`);
        elements.push(decoded);
        cursor = next;
      });
      return [elements, cursor];
    }
    case 'struct': {
      const value: { [field: string]: CompactValue } = {};
      let cursor = offset;
      for (const field of type.fields) {
        const [fieldValue, next] = decodeFrom(bytes, cursor, field.type, `${label}.${field.name}`);
        // defineProperty, not assignment: a field named '__proto__' is a
        // legal Compact identifier, and plain assignment would hit the
        // prototype setter and silently drop it.
        Object.defineProperty(value, field.name, {
          value: fieldValue,
          enumerable: true,
          writable: true,
          configurable: true,
        });
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
