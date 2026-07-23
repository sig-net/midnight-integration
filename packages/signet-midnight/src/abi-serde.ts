// The two schema-driven conversions every signet participant performs on the
// respond path, named after the protocol fields that drive them:
//
//   EVM call result --deserializeEvmOutput--> decoded values
//                        (outputDeserializationSchema)
//   decoded values --serializeRespondOutput--> RespondBidirectionalEvent bytes
//                        (respondSerializationSchema)
//
// Who runs them:
//   - fakenet (and eventually the real MPC): both, back to back, after the
//     destination-chain transaction confirms.
//   - signet clients: both, to independently recompute the exact respond
//     bytes the MPC attested (read the EVM result off chain, re-encode, then
//     hand the result to their Compact contract for claim/validation) or to
//     display a decoded result.
//
// The respond output is UNBOUNDED: this module never pads or clamps it. The
// protocol attests a hash of the bytes, clients fetch the full output off
// chain and recompute; any fixed event-field width is the caller's concern.
//
// Schemas are the ABI-style JSON carried on chain (NUL-padded fixed-width
// bytes). Both functions accept the schema in any form: already-parsed
// fields, a JSON string, or the raw on-chain bytes.
//
// Validation is split exactly the way the MPC splits it:
//   - decode side: the type grammar is left FULLY to the ABI library
//     (ethers), the same way the MPC delegates to alloy's DynSolType parser.
//     This module only checks the schema's shape (a non-empty array of
//     uniquely, non-emptily named fields).
//   - respond side: the restricted Compact-carrier vocabulary below is the
//     law, strictly enforced: unknown types, missing capacities, duplicate
//     names and malformed JSON all throw with the offending field named.
//
// The respond byte layout is Compact's builtin serialize<T, N> /
// deserialize<T, N> (via @sig-net/midnight-serde, pinned against compiled
// circuits), so a consumer contract reads the payload with ONE
// deserialize<T, N> call. Per-type mapping (Compact struct field on the
// right):
//   bool            1 byte                    Boolean
//   uint8..uint248  ceil(bits / 8) bytes LE   Uint<bits>
//   uint256, field  32 bytes LE, below Fr     Field
//   address         32 bytes LE (numeric)     Field
//   bytes1..bytes32 N raw bytes               Bytes<N>
//   string, bytes   8-byte LE length + payload zero-padded to maxBytes
//                                             struct { len: Uint<64>; data: Bytes<maxBytes>; }
//   T[]             8-byte LE count + maxItems elements at T's width
//                                             struct { len: Uint<64>; items: Vector<maxItems, T>; }
//   intN            rejected: Compact has no signed integers

import { ethers } from "ethers";

import {
  compactSerialize,
  type CompactType,
  type CompactValue,
} from "@sig-net/midnight-serde";

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

/** Fixed-width schema types: the byte size follows entirely from the type. */
export type AbiFixedType =
  | "bool"
  | "address"
  | "field"
  | `uint${number}`
  | `bytes${number}`;

export interface AbiFixedField {
  name: string;
  type: AbiFixedType;
}

/**
 * A dynamic string/bytes field. `maxBytes` is the fixed Compact buffer
 * capacity (Compact types are fixed-size, so capacity is part of the type).
 */
export interface AbiDynamicField {
  name: string;
  type: "string" | "bytes";
  maxBytes: number;
}

/** A dynamic array field. `maxItems` is the fixed Compact vector capacity. */
export interface AbiArrayField {
  name: string;
  type: `${AbiFixedType}[]`;
  maxItems: number;
}

export type AbiSchemaField = AbiFixedField | AbiDynamicField | AbiArrayField;

/** An ABI-style schema exactly as carried on chain (JSON array of fields). */
export type AbiSchema = AbiSchemaField[];

/** Any form a respond schema arrives in: parsed, JSON text, or NUL-padded raw bytes. */
export type AbiSchemaInput = AbiSchema | string | Uint8Array;

/**
 * A decode-side schema field: `type` is ANY type string the ABI library
 * accepts (the canonical ABI grammar, so signed ints, tuples and unbounded
 * arrays are all fine here). The restricted {@link AbiSchemaField} vocabulary
 * is a respond-side concern only, and is assignable to this shape.
 */
export interface EvmSchemaField {
  name: string;
  type: string;
}

/** Any form a decode schema arrives in: parsed, JSON text, or NUL-padded raw bytes. */
export type EvmSchemaInput = readonly EvmSchemaField[] | string | Uint8Array;

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

/**
 * Decoded output values, keyed by schema field name. Numerics are bigint,
 * bools boolean, address/bytesN/bytes/string are the forms ethers produces
 * (hex or text strings) or Uint8Array, arrays are plain arrays.
 * `serializeRespondOutput` accepts all of these (plus plain numbers and
 * numeric strings, the forms indexer JSON typically yields).
 */
export type AbiDecodedValue =
  | bigint
  | boolean
  | number
  | string
  | Uint8Array
  | AbiDecodedValue[];

export type AbiDecodedOutput = { [field: string]: AbiDecodedValue };

// ---------------------------------------------------------------------------
// 1. EVM call result -> decoded values  (outputDeserializationSchema)
// ---------------------------------------------------------------------------

/**
 * Decode a raw EVM call result (eth_call return data / debug_trace output)
 * into named values, driven by the request's outputDeserializationSchema.
 *
 * Type validation is FULLY delegated to ethers (the canonical ABI grammar,
 * mirroring the MPC's delegation to alloy): this function only checks the
 * schema's shape, then hands the type strings straight to the ABI coder.
 *
 * Returns a plain object keyed by field name (never an ethers `Result`, so it
 * survives JSON round-trips and structural comparison), with nested ethers
 * Results flattened to plain arrays.
 *
 * @param schema - The outputDeserializationSchema: parsed, JSON text, or the raw NUL-padded on-chain bytes.
 * @param callResult - The ABI-encoded return data (hex string or bytes).
 * @returns The decoded values keyed by schema field name.
 */
export function deserializeEvmOutput(
  schema: EvmSchemaInput,
  callResult: ethers.BytesLike
): AbiDecodedOutput {
  const fields = parseSchemaShape(schema);
  const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
    fields.map((field) => field.type),
    callResult
  );
  const output: AbiDecodedOutput = {};
  fields.forEach((field, i) => {
    output[field.name] = toPlainValue(decoded[i], field.name);
  });
  return output;
}

// ---------------------------------------------------------------------------
// 2. decoded values -> respond bytes  (respondSerializationSchema)
// ---------------------------------------------------------------------------

/**
 * Encode decoded output values into the respond payload, driven by the
 * request's respondSerializationSchema. The bytes are exactly what a consumer
 * contract reads with `deserialize<T, N>` and what the MPC attests, so
 * clients can recompute and verify them independently.
 *
 * The result is the PACKED value, unpadded and unbounded: its length follows
 * entirely from the schema. Padding to any fixed container width is the
 * caller's concern.
 *
 * Strict: values are range-checked (Uint widths, the Field modulus, the
 * 2^160 address bound), dynamic payloads must fit their capacity (no silent
 * truncation), and signed integer types are rejected outright.
 *
 * @param schema - The respondSerializationSchema: parsed, JSON text, or the raw NUL-padded on-chain bytes.
 * @param output - Decoded values keyed by field name (from {@link deserializeEvmOutput} or any source using the same forms).
 * @returns The packed respond bytes.
 */
export function serializeRespondOutput(
  schema: AbiSchemaInput,
  output: AbiDecodedOutput
): Uint8Array {
  const fields = normalizeRespondSchema(schema);
  const descriptor = respondSchemaToCompactType(fields);
  const value: { [field: string]: CompactValue } = {};
  for (const field of fields) {
    const raw = output[field.name];
    if (raw === undefined) {
      throw new Error(`respond output: missing value for '${field.name}'`);
    }
    value[field.name] = toCompactValue(raw, field);
  }
  return compactSerialize(descriptor, value);
}

// ===========================================================================
// Helpers from here down. The two functions above are the whole public
// surface; everything below serves them.
// ===========================================================================

// ---------------------------------------------------------------------------
// Field-kind guards
// ---------------------------------------------------------------------------

export function isAbiDynamicField(field: AbiSchemaField): field is AbiDynamicField {
  return field.type === "string" || field.type === "bytes";
}

export function isAbiArrayField(field: AbiSchemaField): field is AbiArrayField {
  return field.type.endsWith("[]");
}

// ---------------------------------------------------------------------------
// Decode-side value flattening
// ---------------------------------------------------------------------------

/** Flatten ethers `Result` arrays into plain arrays, pass scalars through. */
function toPlainValue(value: unknown, label: string): AbiDecodedValue {
  if (value instanceof ethers.Result) {
    return value.toArray().map((v, i) => toPlainValue(v, `${label}[${i}]`));
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => toPlainValue(v, `${label}[${i}]`));
  }
  if (
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new Error(`${label}: un-decodable ABI value of type ${typeof value}`);
}

// ---------------------------------------------------------------------------
// Schema parsing + validation
// ---------------------------------------------------------------------------

const ADDRESS_BOUND = 1n << 160n;
const MAX_UINT_BITS = 248;
/** Length-prefix width of the dynamic string/bytes/array convention (Uint<64>). */
const DYN_LEN_BYTES = 8;

/** A shape-checked but vocabulary-unchecked schema field. */
interface RawSchemaField {
  name: string;
  type: string;
  maxBytes?: unknown;
  maxItems?: unknown;
}

/**
 * Parse a schema in any input form and check its SHAPE only: a non-empty
 * array of fields with non-empty, unique names and non-empty type strings.
 * The type grammar is deliberately not checked here: the decode side leaves
 * it fully to the ABI library, the respond side runs
 * {@link normalizeRespondSchema} on top.
 */
function parseSchemaShape(schema: EvmSchemaInput | AbiSchemaInput): RawSchemaField[] {
  const parsed: unknown =
    typeof schema === "string" || schema instanceof Uint8Array
      ? JSON.parse(schemaText(schema))
      : schema;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("schema must be a non-empty JSON array of fields");
  }
  const seen = new Set<string>();
  return parsed.map((raw: unknown, i) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`schema field ${i} is not an object`);
    }
    const { name, type, maxBytes, maxItems } = raw as Record<string, unknown>;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`schema field ${i} needs a non-empty name`);
    }
    if (seen.has(name)) {
      throw new Error(`schema: duplicate field name '${name}'`);
    }
    seen.add(name);
    if (typeof type !== "string" || type.length === 0) {
      throw new Error(`schema: '${name}' needs a type`);
    }
    return { name, type, maxBytes, maxItems };
  });
}

/**
 * Enforce the respond-side Compact-carrier vocabulary on a shape-checked
 * schema: every type needs a Compact carrier (no signed ints, uint widths of
 * at most 248 bits or exactly 256, bytesN at most 32) and every dynamic field
 * needs its fixed capacity.
 */
function normalizeRespondSchema(schema: AbiSchemaInput): AbiSchema {
  return parseSchemaShape(schema).map(({ name, type, maxBytes, maxItems }) => {
    if (type === "string" || type === "bytes") {
      assertCapacity(maxBytes, `'${name}' (${type}) maxBytes`);
      return { name, type, maxBytes };
    }
    if (type.endsWith("[]")) {
      assertFixedType(type.slice(0, -2), name);
      assertCapacity(maxItems, `'${name}' (${type}) maxItems`);
      return { name, type: type as AbiArrayField["type"], maxItems };
    }
    assertFixedType(type, name);
    return { name, type: type as AbiFixedType };
  });
}

/** Cut a NUL-padded on-chain schema at the first NUL and decode to text. */
function schemaText(schema: string | Uint8Array): string {
  const raw =
    typeof schema === "string" ? schema : new TextDecoder().decode(schema);
  const nul = raw.indexOf("\0");
  return nul === -1 ? raw : raw.slice(0, nul);
}

function assertCapacity(value: unknown, label: string): asserts value is number {
  if (value === undefined) {
    throw new Error(`schema: ${label} is required: Compact types are fixed-size`);
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`schema: ${label} must be a positive integer`);
  }
}

function assertFixedType(type: string, fieldName: string): void {
  if (type === "bool" || type === "address" || type === "field") return;
  if (/^int\d+$/.test(type)) {
    throw new Error(
      `schema: '${fieldName}' (${type}) is unsupported: Compact has no signed integers`
    );
  }
  const uintMatch = type.match(/^uint(\d+)$/);
  if (uintMatch) {
    const bits = Number(uintMatch[1]);
    const compactOk = (bits >= 1 && bits <= MAX_UINT_BITS) || bits === 256;
    if (!compactOk) {
      throw new Error(
        `schema: '${fieldName}' (${type}) has no Compact carrier: ` +
          `Uint widths stop at ${MAX_UINT_BITS} bits (uint256 maps to Field)`
      );
    }
    return;
  }
  const bytesMatch = type.match(/^bytes(\d+)$/);
  if (bytesMatch) {
    const n = Number(bytesMatch[1]);
    if (n < 1 || n > 32) {
      throw new Error(`schema: '${fieldName}' (${type}) is not a valid bytesN type`);
    }
    return;
  }
  throw new Error(`schema: '${fieldName}' has unsupported type '${type}'`);
}

// ---------------------------------------------------------------------------
// Schema -> CompactType descriptor + value coercion
// ---------------------------------------------------------------------------

function fixedCompactType(type: AbiFixedType): CompactType {
  if (type === "bool") return { kind: "boolean" };
  if (type === "field" || type === "uint256" || type === "address") {
    return { kind: "field" };
  }
  const uintMatch = type.match(/^uint(\d+)$/);
  if (uintMatch) return { kind: "uint", bits: Number(uintMatch[1]) };
  const bytesMatch = type.match(/^bytes(\d+)$/);
  if (bytesMatch) return { kind: "bytes", length: Number(bytesMatch[1]) };
  throw new Error(`unsupported fixed type '${type}'`);
}

function respondSchemaToCompactType(fields: AbiSchema): CompactType {
  return {
    kind: "struct",
    fields: fields.map((field) => {
      if (isAbiDynamicField(field)) {
        return {
          name: field.name,
          type: {
            kind: "struct",
            fields: [
              { name: "len", type: { kind: "uint", bits: DYN_LEN_BYTES * 8 } },
              { name: "data", type: { kind: "bytes", length: field.maxBytes } },
            ],
          } satisfies CompactType,
        };
      }
      if (isAbiArrayField(field)) {
        return {
          name: field.name,
          type: {
            kind: "struct",
            fields: [
              { name: "len", type: { kind: "uint", bits: DYN_LEN_BYTES * 8 } },
              {
                name: "items",
                type: {
                  kind: "vector",
                  length: field.maxItems,
                  element: fixedCompactType(field.type.slice(0, -2) as AbiFixedType),
                },
              },
            ],
          } satisfies CompactType,
        };
      }
      return { name: field.name, type: fixedCompactType(field.type) };
    }),
  };
}

function toCompactValue(value: AbiDecodedValue, field: AbiSchemaField): CompactValue {
  const { name } = field;

  if (isAbiDynamicField(field)) {
    const payload =
      field.type === "string"
        ? new TextEncoder().encode(asString(value, name))
        : asBytes(value, name);
    if (payload.length > field.maxBytes) {
      throw new Error(
        `'${name}': payload is ${payload.length} bytes, maxBytes is ${field.maxBytes}`
      );
    }
    const data = new Uint8Array(field.maxBytes);
    data.set(payload);
    return { len: BigInt(payload.length), data };
  }

  if (isAbiArrayField(field)) {
    if (!Array.isArray(value)) {
      throw new Error(`'${name}' (${field.type}) expects an array`);
    }
    if (value.length > field.maxItems) {
      throw new Error(
        `'${name}': ${value.length} elements, maxItems is ${field.maxItems}`
      );
    }
    const elementType = field.type.slice(0, -2) as AbiFixedType;
    const items = value.map((element, i) =>
      fixedCompactValue(element, elementType, `${name}[${i}]`)
    );
    // Unused capacity encodes as zero values of the element type.
    while (items.length < field.maxItems) items.push(zeroOf(elementType));
    return { len: BigInt(value.length), items };
  }

  return fixedCompactValue(value, field.type, name);
}

function fixedCompactValue(
  value: AbiDecodedValue,
  type: AbiFixedType,
  label: string
): CompactValue {
  if (type === "bool") {
    if (typeof value !== "boolean") {
      throw new Error(`'${label}' (bool) expects a boolean`);
    }
    return value;
  }
  if (/^bytes\d+$/.test(type)) {
    const raw = asBytes(value, label);
    const expected = Number(type.slice(5));
    if (raw.length !== expected) {
      throw new Error(
        `'${label}' (${type}) expects exactly ${expected} bytes, got ${raw.length}`
      );
    }
    return raw;
  }
  // Numeric carriers: uintN, uint256/field and address.
  const n = asBigint(value, label);
  if (type === "address" && n >= ADDRESS_BOUND) {
    throw new Error(`'${label}': value ${n} exceeds an address`);
  }
  // Uint width and Field modulus bounds are enforced by @sig-net/midnight-serde.
  return n;
}

function zeroOf(type: AbiFixedType): CompactValue {
  if (type === "bool") return false;
  if (/^bytes\d+$/.test(type)) return new Uint8Array(Number(type.slice(5)));
  return 0n;
}

// ---------------------------------------------------------------------------
// Value-form coercions
// ---------------------------------------------------------------------------

function asBigint(value: AbiDecodedValue, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string") {
    try {
      return BigInt(value);
    } catch {
      throw new Error(`'${label}': cannot parse '${value}' as an integer`);
    }
  }
  throw new Error(`'${label}': expected an integer-like value`);
}

function asBytes(value: AbiDecodedValue, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return ethers.getBytes(value);
  throw new Error(`'${label}': expected bytes (Uint8Array or hex string)`);
}

function asString(value: AbiDecodedValue, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`'${label}': expected a string`);
  }
  return value;
}
