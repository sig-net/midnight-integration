// The two schema-driven conversions every Signet participant performs on the
// respond path, named after the protocol fields that drive them, and the
// MPC's rule composing them for an executed EVM transaction:
//
//   EVM call result --deserializeEvmOutput--> decoded values
//                        (outputDeserializationSchema)
//   decoded values --serializeRespondOutput--> RespondBidirectionalEvent bytes
//                        (respondSerializationSchema)
//   callTracer top frame --evmTraceOutputFromCallFrame--> the trace
//   executed EVM transaction --executedEvmRespondOutput--> attested bytes
//                        (both schemas, isEvmContractCall, the trace)
//
// Run by fakenet and the real MPC after the destination-chain transaction
// confirms, and by Signet clients to independently recompute the respond
// bytes the MPC attested or to display a decoded result. A client
// recomputing an attestation calls executedEvmRespondOutput: the MPC decodes
// and re-packs a contract call's return data, and synthesises the output
// of a plain transfer or a void call from the respond schema alone.
//
// The respond output is UNBOUNDED: this module never pads or clamps it. Any
// fixed event-field width is the caller's concern. Schemas are the ABI-style
// JSON carried on chain (NUL-padded fixed-width bytes). Every function
// accepts the schema in any form: already-parsed fields, a JSON string, or
// the raw on-chain bytes. An EMPTY output schema (an unset all-NUL field, a
// blank string, or `[]`) decodes to no values. A respond schema must be
// non-empty, and its declared capacities are bounded
// ({@link MAX_RESPOND_PACKED_BYTES}): schemas are requester-authored
// on-chain data, so the responder never honours a schema demanding a giant
// allocation.
//
// Decode-side type grammar is left FULLY to the ABI library (ethers): this
// module checks only the schema's shape. Respond-side types are restricted
// to the Compact-carrier vocabulary below, strictly enforced.
//
// The respond byte layout is Compact's builtin serialize<T, N> /
// deserialize<T, N> (via @sig-net/midnight-serde, pinned against compiled
// circuits), so a consumer contract reads the payload with ONE
// deserialize<T, N> call. Per-type mapping (Compact struct field on the
// right):
//   bool            1 byte                    Boolean
//   uint8..uint248  bits / 8 bytes LE         Uint<bits>
//     (whole-byte widths only: multiples of 8, others are rejected)
//   uint256, field  32 bytes LE, below Fr     Field
//   address         32 bytes LE (numeric)     Field
//   bytes1..bytes32 N raw bytes               Bytes<N>
//   string, bytes   8-byte LE length + payload zero-padded to maxBytes
//                                             struct { len: Uint<64>; data: Bytes<maxBytes>; }
//   T[]             8-byte LE count + maxItems elements at T's width
//                                             struct { len: Uint<64>; items: Vector<maxItems, T>; }
//   intN            rejected: Compact has no signed integers
//
// RANGE TRAP: uint256, address and field all map to Compact `Field`, whose
// values must lie strictly below the BLS12-381 Fr modulus (just under
// 2^255). An EVM uint256 at or above Fr cannot be respond-serialised, and
// `serializeRespondOutput` throws at respond time. Schema authors who need
// the full 256-bit range carry the value as bytes32.

import {
  compactSerialize,
  compactSerializedSize,
  type CompactType,
  type CompactValue,
} from "@sig-net/midnight-serde";
import { ethers } from "ethers";

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

/** Fixed-width schema types: the byte size follows entirely from the type. */
export type AbiFixedType = "bool" | "address" | "field" | `uint${number}` | `bytes${number}`;

/** A fixed-width schema field: its byte size follows entirely from its type. */
export interface AbiFixedField {
  name: string;
  type: AbiFixedType;
}

/** A dynamic string/bytes field. `maxBytes` is the fixed Compact buffer capacity. */
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

/** One respond-schema field: fixed-width, dynamic string/bytes, or array. */
export type AbiSchemaField = AbiFixedField | AbiDynamicField | AbiArrayField;

/** An ABI-style schema exactly as carried on chain (JSON array of fields). */
export type AbiSchema = AbiSchemaField[];

/** Any form a respond schema arrives in: parsed, JSON text, or NUL-padded raw bytes. */
export type AbiSchemaInput = AbiSchema | string | Uint8Array;

/**
 * A decode-side schema field: `type` is ANY type string the ABI library
 * accepts. The restricted {@link AbiSchemaField} vocabulary is a respond-side
 * concern only, and is assignable to this shape.
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
export type AbiDecodedValue = bigint | boolean | number | string | Uint8Array | AbiDecodedValue[];

/** Decoded output values keyed by schema field name (see {@link AbiDecodedValue}). */
export type AbiDecodedOutput = Record<string, AbiDecodedValue>;

// ---------------------------------------------------------------------------
// 1. EVM call result -> decoded values  (outputDeserializationSchema)
// ---------------------------------------------------------------------------

/**
 * Decode a raw EVM call result (eth_call return data / debug_trace output)
 * into named values, driven by the request's outputDeserializationSchema.
 * The decode-side counterpart of {@link serializeRespondOutput}. Type
 * validation is FULLY delegated to ethers: this function checks the schema's
 * shape only. An empty schema decodes to an empty object. The MPC never
 * decodes under an empty schema: {@link executedEvmRespondOutput} carries
 * its rule for that case. Returns a plain object (never an ethers
 * `Result`), so it survives JSON round-trips and structural comparison.
 *
 * @param schema - The outputDeserializationSchema: parsed, JSON text, or the raw NUL-padded on-chain bytes.
 * @param callResult - The ABI-encoded return data (hex string or bytes).
 * @returns The decoded values keyed by schema field name, empty for an empty schema.
 */
export function deserializeEvmOutput(
  schema: EvmSchemaInput,
  callResult: ethers.BytesLike,
): AbiDecodedOutput {
  const fields = parseSchemaShape(schema);
  if (fields.length === 0) {
    return {};
  }
  const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
    fields.map((field) => field.type),
    callResult,
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
 * Ceiling on a respond schema's total packed byte width. Schemas are
 * requester-authored on-chain data, so unbounded maxBytes/maxItems would let
 * a hostile request demand giant allocations from the responder. A real
 * respond payload must fit its consumer contract's fixed `deserialize<T, N>`
 * width, orders of magnitude below this.
 */
export const MAX_RESPOND_PACKED_BYTES = 65536;

/**
 * Encode decoded output values into the respond payload, driven by the
 * request's respondSerializationSchema: the bytes a consumer contract reads
 * with `deserialize<T, N>` and the MPC attests. The respond-side counterpart
 * of {@link deserializeEvmOutput}.
 *
 * The result is the PACKED value, unpadded and unbounded: its length follows
 * entirely from the schema, and padding to a fixed container width is the
 * caller's concern. Strict: values are range-checked, dynamic payloads must
 * fit their capacity with no silent truncation, and signed integer types are
 * rejected.
 *
 * @param schema - The respondSerializationSchema: parsed, JSON text, or the raw NUL-padded on-chain bytes.
 * @param output - Decoded values keyed by field name (from {@link deserializeEvmOutput} or any source using the same forms).
 * @returns The packed respond bytes.
 * @throws {Error} If the schema is empty or malformed, packs to more than
 *   {@link MAX_RESPOND_PACKED_BYTES} bytes, a value falls outside its declared
 *   range, or a dynamic payload exceeds its capacity.
 */
export function serializeRespondOutput(
  schema: AbiSchemaInput,
  output: AbiDecodedOutput,
): Uint8Array {
  const fields = normalizeRespondSchema(schema);
  // Size the descriptor BEFORE any value work: the ceiling check is what
  // keeps a hostile capacity from ever reaching an allocation.
  const descriptor = respondSchemaToCompactType(fields);
  const packedWidth = compactSerializedSize(descriptor);
  if (packedWidth > MAX_RESPOND_PACKED_BYTES) {
    throw new Error(
      `respond schema packs to ${String(packedWidth)} bytes, above the ` +
        `${String(MAX_RESPOND_PACKED_BYTES)}-byte ceiling`,
    );
  }
  const value: Record<string, CompactValue> = {};
  for (const field of fields) {
    const raw = output[field.name];
    if (raw === undefined) {
      throw new Error(`respond output: missing value for '${field.name}'`);
    }
    value[field.name] = toCompactValue(raw, field);
  }
  return compactSerialize(descriptor, value);
}

// Helpers from here down. The exports above are the whole public surface:
// everything below serves them.
=======
/**
 * The Compact descriptor a respond schema maps to: the exact
 * {@link CompactType} that {@link serializeRespondOutput} serializes with,
 * exposed so conformance tooling can pin the schema-to-descriptor mapping
 * (and the bytes it produces) without re-implementing the vocabulary.
 *
 * @param schema - The respondSerializationSchema: parsed, JSON text, or the raw NUL-padded on-chain bytes.
 * @returns The struct descriptor covering every schema field in order.
 * @throws If the schema is malformed or uses a type outside the respond vocabulary.
 */
export function respondSchemaDescriptor(schema: AbiSchemaInput): CompactType {
  return respondSchemaToCompactType(normalizeRespondSchema(schema));
}

// ---------------------------------------------------------------------------
// 3. executed EVM transaction -> attested respond bytes
// ---------------------------------------------------------------------------

/**
 * Whether an EVM transaction is a contract call, decided over its input
 * bytes exactly as the MPC decides it (`is_contract_call` in its
 * `chain-ethereum/src/event_parsing.rs`): more than two bytes of input, so a
 * one- or two-byte input is NOT a contract call. The answer selects the
 * branch of {@link executedEvmRespondOutput}.
 *
 * Pass the signed transaction's `data`, or, from the request record alone,
 * `assembleCalldata(request.txParams.calldata)`, which yields the same bytes
 * (`"0x"` for a request without calldata).
 *
 * @param input - The transaction's input bytes (hex string or bytes).
 * @returns True when the MPC treats the transaction as a contract call.
 * @throws {Error} If `input` is neither bytes nor valid 0x hex.
 */
export function isEvmContractCall(input: ethers.BytesLike): boolean {
  return ethers.getBytes(input).length > 2;
}

/**
 * How a `debug_traceTransaction` (callTracer) read of a transaction's top
 * call frame came back: the MPC's `TraceOutput`. Carried by
 * {@link EvmTraceOutput}.
 */
export enum EvmTraceOutputKind {
  /** The transaction was not traced: the MPC traces contract calls only. */
  NotTraced = "NotTraced",
  /** The top call frame carries a string `output` field: the return data, possibly empty (`0x`). */
  Output = "Output",
  /** The top call frame carries no string `output` field. */
  NoReturnData = "NoReturnData",
}

/**
 * The traced return data of an EVM transaction, as the MPC models it: a top
 * call frame's string `output` field (even `0x`) is
 * {@link EvmTraceOutputKind.Output}, an absent or non-string one is
 * {@link EvmTraceOutputKind.NoReturnData}. {@link evmTraceOutputFromCallFrame}
 * reads it off a frame.
 */
export type EvmTraceOutput =
  | {
      /** The frame carried an `output` field. */
      readonly kind: EvmTraceOutputKind.Output;
      /** The frame's `output`: the ABI-encoded return data (hex string or bytes). */
      readonly returnData: ethers.BytesLike;
    }
  | {
      /** The frame carried no `output` field. */
      readonly kind: EvmTraceOutputKind.NoReturnData;
    }
  | {
      /** No trace was taken. */
      readonly kind: EvmTraceOutputKind.NotTraced;
    };

/**
 * A request's two respond-path schemas, each in any form its conversion
 * accepts. An on-ledger request record (`SignBidirectionalEvent`) satisfies
 * it, as does the pair read off one as JSON text.
 */
export interface RespondPathSchemas {
  /** The outputDeserializationSchema, which {@link deserializeEvmOutput} decodes the return data with. */
  readonly outputDeserializationSchema: EvmSchemaInput;
  /** The respondSerializationSchema, which {@link serializeRespondOutput} packs the respond bytes with. */
  readonly respondSerializationSchema: AbiSchemaInput;
}

/** The string default the MPC synthesises for an execution without call output. */
const NON_FUNCTION_CALL_SUCCESS = "non_function_call_success";

/**
 * The per-field values the MPC synthesises for an execution without call
 * output (its `default_value_for_kind`): `true` for a bool field,
 * {@link NON_FUNCTION_CALL_SUCCESS} for a string field.
 *
 * @param respondSchema - The respondSerializationSchema.
 * @returns The synthesised values keyed by field name.
 * @throws {Error} If the schema is one {@link serializeRespondOutput}
 *   rejects, or a field is of any other kind.
 */
function nonFunctionCallDefaults(respondSchema: AbiSchemaInput): AbiDecodedOutput {
  const output: AbiDecodedOutput = {};
  for (const field of normalizeRespondSchema(respondSchema)) {
    if (field.type === "bool") {
      output[field.name] = true;
    } else if (field.type === "string") {
      output[field.name] = NON_FUNCTION_CALL_SUCCESS;
    } else {
      throw new Error(
        `respond output: '${field.name}' (${field.type}) has no non-function-call ` +
          "default: only bool and string fields have one",
      );
    }
  }
  return output;
}

/**
 * The exact serialised respond output the MPC attests for an EVM transaction
 * that executed (the payload of an `OutputKind.executed` attestation),
 * mirroring the MPC's `build_serialized_output` under the Midnight respond
 * format:
 *
 * - Not a contract call: the output schema and the trace are ignored, and
 *   the respond fields get synthesised defaults (bool `true`, string
 *   `"non_function_call_success"` in its `maxBytes` buffer, any other kind
 *   throws).
 * - A contract call under an EMPTY output schema (a void call): the same
 *   defaults when the trace has no or empty return data, a throw when it
 *   returned data.
 * - A contract call under a non-empty output schema: the return data
 *   decoded by {@link deserializeEvmOutput} and packed by
 *   {@link serializeRespondOutput}, a throw when the trace has no return
 *   data.
 *
 * A contract call that was not traced always throws. A failed or unviable
 * execution is attested over an empty output instead, which needs no call.
 *
 * @param schemas - The request's two schemas (a request record satisfies this).
 * @param isContractCall - Whether the transaction is a contract call, as {@link isEvmContractCall} decides it.
 * @param trace - The transaction's traced return data (`NotTraced` for an untraced plain transfer).
 * @returns The packed respond bytes, unpadded.
 * @throws {Error} Exactly where the MPC refuses to attest an execution: a
 *   contract call not traced, an empty output schema with return data, a
 *   non-empty output schema with no or undecodable return data, a malformed
 *   output schema on a contract call, a respond field without a synthesised
 *   default, and every {@link serializeRespondOutput} rejection.
 */
export function executedEvmRespondOutput(
  schemas: RespondPathSchemas,
  isContractCall: boolean,
  trace: EvmTraceOutput,
): Uint8Array {
  const { outputDeserializationSchema, respondSerializationSchema } = schemas;
  if (!isContractCall) {
    return serializeRespondOutput(
      respondSerializationSchema,
      nonFunctionCallDefaults(respondSerializationSchema),
    );
  }
  const expectsNoOutput = parseSchemaShape(outputDeserializationSchema).length === 0;
  switch (trace.kind) {
    case EvmTraceOutputKind.NotTraced:
      throw new Error("respond output: a contract call's output needs its trace");
    case EvmTraceOutputKind.NoReturnData:
      if (!expectsNoOutput) {
        throw new Error(
          "respond output: the contract call's trace has no return data for a non-empty output schema",
        );
      }
      break;
    case EvmTraceOutputKind.Output:
      if (!expectsNoOutput) {
        return serializeRespondOutput(
          respondSerializationSchema,
          deserializeEvmOutput(outputDeserializationSchema, trace.returnData),
        );
      }
      if (ethers.getBytes(trace.returnData).length > 0) {
        throw new Error(
          "respond output: the contract call returned data but its output schema declares no return values",
        );
      }
      break;
  }
  return serializeRespondOutput(
    respondSerializationSchema,
    nonFunctionCallDefaults(respondSerializationSchema),
  );
}

/** A parsed JSON object. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Any parsed JSON value: the shape of a JSON-RPC `result`. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

/**
 * Whether a JSON value is an object. A type guard, as `Array.isArray` does
 * not narrow a readonly array out of a union.
 *
 * @param value - The JSON value.
 * @returns True for a JSON object, false for an array, a scalar or null.
 */
function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A JSON object's own property when it is a string.
 *
 * @param object - The JSON object.
 * @param key - The property name.
 * @returns The string value, or `undefined` when absent or of another JSON kind.
 */
function ownString(object: JsonObject, key: string): string | undefined {
  const value = Object.hasOwn(object, key) ? object[key] : undefined;
  return typeof value === "string" ? value : undefined;
}

/**
 * The {@link EvmTraceOutput} of a `debug_traceTransaction` callTracer top
 * call frame, read exactly as the MPC reads it (`trace_output_to_bytes` in
 * its `chain-ethereum/src/rpc.rs`):
 *
 * - The frame must be a JSON object with a `type` field (of any value).
 * - A non-empty string `error` refuses the frame, naming a non-empty string
 *   `revertReason` beside it. Any other `error` is ignored.
 * - A string `output` is {@link EvmTraceOutputKind.Output}, its hex decoded
 *   after one optional lowercase `0x` prefix (`0x` and `""` are empty return
 *   data). An absent or non-string `output` is
 *   {@link EvmTraceOutputKind.NoReturnData}.
 *
 * @param frame - The JSON-RPC `result` of `debug_traceTransaction` with the callTracer.
 * @returns The frame's traced return data, for {@link executedEvmRespondOutput}.
 * @throws {Error} If the frame is not an object, has no `type`, reports an
 *   `error`, or carries an `output` that is not even-length hex.
 */
export function evmTraceOutputFromCallFrame(frame: JsonValue): EvmTraceOutput {
  if (!isJsonObject(frame)) {
    throw new Error(`debug_traceTransaction result is not a call frame: ${JSON.stringify(frame)}`);
  }
  if (!Object.hasOwn(frame, "type")) {
    throw new Error(
      `debug_traceTransaction result has no call frame \`type\`: ${JSON.stringify(frame)}`,
    );
  }
  const error = ownString(frame, "error");
  if (error !== undefined && error !== "") {
    const revertReason = ownString(frame, "revertReason");
    throw new Error(
      revertReason !== undefined && revertReason !== ""
        ? `debug_traceTransaction reports the call reverted: ${error} (${revertReason})`
        : `debug_traceTransaction reports the call errored: ${error}`,
    );
  }
  const output = ownString(frame, "output");
  if (output === undefined) {
    return { kind: EvmTraceOutputKind.NoReturnData };
  }
  const digits = output.startsWith("0x") ? output.slice(2) : output;
  if (!/^[0-9a-fA-F]*$/.test(digits) || digits.length % 2 !== 0) {
    throw new Error(`debug_traceTransaction call frame output is not hex: "${output}"`);
  }
  return { kind: EvmTraceOutputKind.Output, returnData: ethers.getBytes(`0x${digits}`) };
}

// ====================================================================// ===========================================================================

// ---------------------------------------------------------------------------
// Field-kind guards
// ---------------------------------------------------------------------------

function isAbiDynamicField(field: AbiSchemaField): field is AbiDynamicField {
  return field.type === "string" || field.type === "bytes";
}

function isAbiArrayField(field: AbiSchemaField): field is AbiArrayField {
  return field.type.endsWith("[]");
}

// ---------------------------------------------------------------------------
// Decode-side value flattening
// ---------------------------------------------------------------------------

/**
 * Flatten ethers `Result` arrays into plain arrays, pass scalars through.
 *
 * @param value - A decoded ABI value, possibly a nested `Result`.
 * @param label - Field path, used in error messages.
 * @returns The value with every `Result` replaced by a plain array.
 * @throws {Error} If the value is of a kind the respond side cannot carry.
 */
function toPlainValue(value: unknown, label: string): AbiDecodedValue {
  if (value instanceof ethers.Result) {
    return value.toArray().map((v, i) => toPlainValue(v, `${label}[${String(i)}]`));
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => toPlainValue(v, `${label}[${String(i)}]`));
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
 * Parse schema text as JSON with the parse failure named. Blank text (an
 * unset all-NUL on-chain schema field) is the empty schema.
 *
 * @param text - The schema text, NUL-trimmed.
 * @returns The parsed JSON value, `[]` for blank text.
 * @throws {Error} If non-blank text is not valid JSON.
 */
function parseSchemaJson(text: string): unknown {
  if (text.trim() === "") {
    return [];
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`schema is not valid JSON (${String(error)})`, { cause: error });
  }
}

/**
 * Parse a schema in any input form and check its SHAPE only: an array of
 * fields with non-empty, unique names and non-empty type strings. An empty
 * schema is valid here: emptiness policy belongs to the callers
 * ({@link deserializeEvmOutput} decodes nothing, {@link serializeRespondOutput}
 * rejects, {@link executedEvmRespondOutput} synthesises defaults for a
 * contract call without return data).
 *
 * @param schema - The schema as JSON text, packed bytes, or a field array.
 * @returns The schema's fields, names and type strings unvalidated beyond shape.
 * @throws {Error} If the schema is not an array of uniquely named fields.
 */
function parseSchemaShape(schema: EvmSchemaInput | AbiSchemaInput): RawSchemaField[] {
  const parsed: unknown =
    typeof schema === "string" || schema instanceof Uint8Array
      ? parseSchemaJson(schemaText(schema))
      : schema;
  if (!Array.isArray(parsed)) {
    throw new Error("schema must be a JSON array of fields");
  }
  const seen = new Set<string>();
  return parsed.map((raw: unknown, i) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`schema field ${String(i)} is not an object`);
    }
    const { name, type, maxBytes, maxItems } = raw as Record<string, unknown>;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`schema field ${String(i)} needs a non-empty name`);
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
 *
 * @param schema - The schema to normalize.
 * @returns The schema with every field proven to have a Compact carrier.
 * @throws {Error} If a type has no carrier or a dynamic field omits its capacity.
 */
function normalizeRespondSchema(schema: AbiSchemaInput): AbiSchema {
  const fields = parseSchemaShape(schema);
  if (fields.length === 0) {
    throw new Error(
      "respond schema is empty: a respond serialization schema needs at least one field",
    );
  }
  return fields.map(({ name, type, maxBytes, maxItems }) => {
    if (type === "string" || type === "bytes") {
      assertCapacity(maxBytes, `'${name}' (${type}) maxBytes`);
      return { name, type, maxBytes };
    }
    if (type.endsWith("[]")) {
      classifyFixedType(type.slice(0, -2), name);
      assertCapacity(maxItems, `'${name}' (${type}) maxItems`);
      return { name, type: type as AbiArrayField["type"], maxItems };
    }
    classifyFixedType(type, name);
    return { name, type: type as AbiFixedType };
  });
}

/**
 * Cut a NUL-padded on-chain schema at the first NUL and decode to text.
 *
 * @param schema - Schema text, or the NUL-padded bytes read from the ledger.
 * @returns The schema text with the padding removed.
 */
function schemaText(schema: string | Uint8Array): string {
  const raw = typeof schema === "string" ? schema : new TextDecoder().decode(schema);
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

/**
 * Classify a fixed-width respond type into its Compact carrier, validating
 * the respond-side vocabulary in one place: both the schema check
 * ({@link normalizeRespondSchema}) and the descriptor build
 * ({@link respondSchemaToCompactType}) call this, so the grammar cannot
 * drift between them. Respond-side uint widths are restricted to whole-byte
 * widths (multiples of 8 from 8 to 248, packing to bits / 8 bytes), plus
 * uint256 which maps to Field. Throws with the offending field named.
 *
 * @param type - The fixed-width ABI type name.
 * @param fieldName - The field the type belongs to, used in error messages.
 * @returns The Compact descriptor that carries the type.
 * @throws {Error} If the type has no respond-side Compact carrier.
 */
function classifyFixedType(type: string, fieldName: string): CompactType {
  if (type === "bool") return { kind: "boolean" };
  if (type === "field" || type === "uint256" || type === "address") {
    return { kind: "field" };
  }
  if (/^int\d+$/.test(type)) {
    throw new Error(
      `schema: '${fieldName}' (${type}) is unsupported: Compact has no signed integers`,
    );
  }
  const uintMatch = /^uint([1-9]\d*)$/.exec(type);
  if (uintMatch) {
    const bits = Number(uintMatch[1]);
    const wholeByteWidth = bits >= 8 && bits <= MAX_UINT_BITS && bits % 8 === 0;
    if (!wholeByteWidth) {
      throw new Error(
        `schema: '${fieldName}' (${type}) has no respond carrier: uint widths ` +
          `must be multiples of 8 from 8 to ${String(MAX_UINT_BITS)}, or uint256 (maps to Field)`,
      );
    }
    return { kind: "uint", bits };
  }
  const bytesMatch = /^bytes([1-9]\d*)$/.exec(type);
  if (bytesMatch) {
    const n = Number(bytesMatch[1]);
    if (n < 1 || n > 32) {
      throw new Error(`schema: '${fieldName}' (${type}) is not a valid bytesN type`);
    }
    return { kind: "bytes", length: n };
  }
  throw new Error(`schema: '${fieldName}' has unsupported type '${type}'`);
}

// ---------------------------------------------------------------------------
// Schema -> CompactType descriptor + value coercion
// ---------------------------------------------------------------------------

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
                  element: classifyFixedType(field.type.slice(0, -2), field.name),
                },
              },
            ],
          } satisfies CompactType,
        };
      }
      return { name: field.name, type: classifyFixedType(field.type, field.name) };
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
        `'${name}': payload is ${String(payload.length)} bytes, maxBytes is ${String(field.maxBytes)}`,
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
        `'${name}': ${String(value.length)} elements, maxItems is ${String(field.maxItems)}`,
      );
    }
    const elementType = field.type.slice(0, -2) as AbiFixedType;
    const items = value.map((element, i) =>
      fixedCompactValue(element, elementType, `${name}[${String(i)}]`),
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
  label: string,
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
        `'${label}' (${type}) expects exactly ${String(expected)} bytes, got ${String(raw.length)}`,
      );
    }
    return raw;
  }
  // Numeric carriers: uintN, uint256/field and address.
  const n = asBigint(value, label);
  if (type === "address" && n >= ADDRESS_BOUND) {
    throw new Error(`'${label}': value ${String(n)} exceeds an address`);
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
  if (typeof value === "string") {
    try {
      return ethers.getBytes(value);
    } catch {
      throw new Error(`'${label}': not a valid 0x hex byte string: "${value}"`);
    }
  }
  throw new Error(`'${label}': expected bytes (Uint8Array or hex string)`);
}

function asString(value: AbiDecodedValue, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`'${label}': expected a string`);
  }
  return value;
}
