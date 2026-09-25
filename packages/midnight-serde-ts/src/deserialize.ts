// Strict boolean and padding policies have independent compatibility options.
// Native Field rejects non-canonical encodings. Foreign fields reduce modulo
// their respective moduli, matching the compiler-generated decoders.

import { fieldModulus, packedSize, uintBound, uintName } from "./serialize.ts";
import type { CompactType, CompactValue, CompactValueOf } from "./types.ts";
import { assertCompactType, assertUnreachable, isUint8Array } from "./validate.ts";

/** Options controlling how strictly {@link compactDeserialize} reads a value. */
export interface CompactDeserializeOptions {
  /** Skip the all-zero check on bytes after the packed value (circuit behaviour). */
  ignorePadding?: boolean;
  /**
   * Decode boolean bytes above 0x01 as false instead of throwing (circuit
   * behaviour: only 0x01 is true, anything else is false).
   */
  lenientBooleans?: boolean;
}

// Zero-width elements (empty structs/tuples, `Uint<0..1>`, single-variant
// enums, `Bytes<0>`) consume no input, so a vector of them decodes purely
// from the descriptor: a validated-but-hostile `Vector<10^15, Nothing>`
// would loop forever on an EMPTY buffer. No real circuit is anywhere near
// this many zero-width elements, so cap them rather than hang.
const MAX_ZERO_WIDTH_ELEMENTS = 65536;

interface DecodeContext {
  readonly lenientBooleans: boolean;
  zeroWidthElements: number;
}

/**
 * Inverse of `compactSerialize`: decode the packed prefix of `bytes`.
 *
 * The return type is derived from the descriptor (see `CompactValueOf`), so a
 * literal descriptor yields a fully typed value with no cast at the call site.
 *
 * @param type - The descriptor describing the packed layout.
 * @param bytes - Buffer whose prefix holds the packed value.
 * @param options - Decode options; see {@link CompactDeserializeOptions}.
 * @returns The decoded value, shaped by the descriptor.
 * @throws {Error} If the descriptor is malformed, the buffer is too short, or a
 *   decoded value falls outside its declared range.
 */
export function compactDeserialize<const T extends CompactType>(
  type: T,
  bytes: Uint8Array,
  options: CompactDeserializeOptions = {},
): CompactValueOf<T> {
  assertCompactType(type);
  if (!isUint8Array(bytes)) {
    throw new Error("bytes must be a Uint8Array");
  }
  // One size check up front covers every read below: fields and elements
  // tile the packed prefix exactly, so no per-node re-check is needed.
  const need = packedSize(type);
  if (need > bytes.length) {
    throw new Error(`value: needs ${String(need)} bytes, buffer has ${String(bytes.length)}`);
  }
  const context: DecodeContext = {
    lenientBooleans: options.lenientBooleans === true,
    zeroWidthElements: 0,
  };
  const [value, consumed] = decodeFrom(bytes, 0, type, "value", context);
  if (!options.ignorePadding) {
    for (const [i, padding] of bytes.subarray(consumed).entries()) {
      if (padding !== 0) {
        throw new Error(
          `non-zero padding byte 0x${padding.toString(16)} at offset ${String(consumed + i)} ` +
            `(pass ignorePadding to mirror the circuit, which reads only the packed prefix)`,
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
  label: string,
  context: DecodeContext,
): [CompactValue, number] {
  switch (type.kind) {
    case "boolean": {
      const b = bytes[offset];
      if (b === undefined) {
        throw new Error(`${label}: buffer ends before the boolean byte at ${String(offset)}`);
      }
      // Strict by default; the circuit decodes any byte != 0x01 as false
      // (see the header comment).
      if (b > 1 && !context.lenientBooleans) {
        throw new Error(`${label}: invalid boolean byte 0x${b.toString(16)}`);
      }
      return [b === 1, offset + 1];
    }
    case "uint": {
      const bound = uintBound(type);
      const size = packedSize(type);
      const value = readUintLE(bytes, offset, size);
      // Mirrors the circuit, which rejects encodings at or above the bound
      // (pinned by tests via the Bounded, Wide and U12 fixtures). Reachable
      // for any bounded uint whose max is not all-ones, and for sized uints
      // only when the width is not byte-aligned.
      if (value >= bound) {
        throw new Error(`${label}: encoding ${String(value)} exceeds ${uintName(type)}`);
      }
      return [value, offset + size];
    }
    case "field":
    case "secp256k1-base":
    case "secp256k1-scalar": {
      const value = readUintLE(bytes, offset, 32);
      if (type.kind === "field" && value >= fieldModulus(type)) {
        throw new Error(`${label}: encoding ${String(value)} is not below the Field modulus`);
      }
      return [value % fieldModulus(type), offset + 32];
    }
    case "bytes":
      // A copy into a PLAIN Uint8Array, never `bytes.slice(...)`: subclasses
      // may override slice with a non-copying view (Buffer does), and a
      // decoded value must not alias caller memory the caller may reuse.
      return [new Uint8Array(bytes.subarray(offset, offset + type.length)), offset + type.length];
    case "enum": {
      const size = packedSize(type);
      const value = readUintLE(bytes, offset, size);
      // Mirrors the circuit's variant-index range check (pinned by tests).
      if (value >= BigInt(type.variants)) {
        throw new Error(
          `${label}: encoding ${String(value)} exceeds the last variant index ${String(type.variants - 1)}`,
        );
      }
      return [Number(value), offset + size];
    }
    case "vector": {
      if (packedSize(type.element) === 0) {
        context.zeroWidthElements += type.length;
        if (context.zeroWidthElements > MAX_ZERO_WIDTH_ELEMENTS) {
          throw new Error(
            `${label}: refusing to materialise over ${String(MAX_ZERO_WIDTH_ELEMENTS)} ` +
              `zero-width vector elements (the descriptor decodes them from no input at all)`,
          );
        }
      }
      const elements: CompactValue[] = [];
      let cursor = offset;
      for (let i = 0; i < type.length; i++) {
        const [element, next] = decodeFrom(
          bytes,
          cursor,
          type.element,
          `${label}[${String(i)}]`,
          context,
        );
        elements.push(element);
        cursor = next;
      }
      return [elements, cursor];
    }
    case "tuple": {
      const elements: CompactValue[] = [];
      let cursor = offset;
      type.elements.forEach((element, i) => {
        const [decoded, next] = decodeFrom(
          bytes,
          cursor,
          element,
          `${label}[${String(i)}]`,
          context,
        );
        elements.push(decoded);
        cursor = next;
      });
      return [elements, cursor];
    }
    case "struct": {
      const value: Record<string, CompactValue> = {};
      let cursor = offset;
      for (const field of type.fields) {
        const [fieldValue, next] = decodeFrom(
          bytes,
          cursor,
          field.type,
          `${label}.${field.name}`,
          context,
        );
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
  let shift = 0n;
  for (const byte of bytes.subarray(offset, offset + size)) {
    v |= BigInt(byte) << shift;
    shift += 8n;
  }
  return v;
}
