import { type BorshValue, compactSerialize, type Schema } from "@sig-net/midnight-serde";
import { ethers } from "ethers";

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

/** A native Borsh schema, JSON text, or NUL-padded on-chain JSON bytes. */
export type RespondSchemaInput = Schema | Uint8Array;

/**
 * A decode-side schema field: `type` is ANY type string the ABI library
 * accepts.
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
 * Parse native Borsh schema JSON from an on-chain field.
 *
 * @param schema - Native schema, JSON text, or NUL-padded bytes.
 * @returns The native Borsh schema.
 * @throws {Error} If schema JSON is malformed.
 */
function respondSchema(schema: RespondSchemaInput): Schema {
  if (schema instanceof Uint8Array) return JSON.parse(schemaText(schema)) as Schema;
  if (typeof schema === "string" && /^\s*[{["]/.test(schema)) {
    return JSON.parse(schema) as Schema;
  }
  return schema;
}

/**
 * Convert ABI numeric and byte representations into native Borsh values.
 * Integer narrowing must fail before the value reaches Borsh's truncating writes.
 *
 * @param schema - Native Borsh schema.
 * @param value - Decoded EVM value.
 * @returns Value in the Borsh representation.
 * @throws {RangeError} If an integer cannot be represented without loss.
 */
function toBorshValue(schema: Schema, value: BorshValue): BorshValue {
  if (typeof schema === "string") {
    const integer = /^([ui])(8|16|32|64|128)$/.exec(schema);
    if (integer) {
      if (typeof value !== "bigint" && typeof value !== "number" && typeof value !== "string") {
        throw new TypeError(`Expected an integer for ${schema}`);
      }
      if (typeof value === "number" && !Number.isSafeInteger(value)) {
        throw new RangeError(`Unsafe integer for ${schema}`);
      }
      const number = BigInt(value);
      const bits = Number(integer[2]);
      const signed = integer[1] === "i";
      const bound = 1n << BigInt(signed ? bits - 1 : bits);
      if (number < (signed ? -bound : 0n) || number >= bound) {
        throw new RangeError(`EVM integer ${String(number)} does not fit Borsh ${schema}`);
      }
      return bits <= 32 ? Number(number) : number;
    }
    return value;
  }
  if ("struct" in schema && typeof value === "object" && value !== null) {
    const record = value as Record<string, BorshValue>;
    return Object.fromEntries(
      Object.entries(schema.struct).map(([name, child]) => {
        const field = record[name];
        if (field === undefined) throw new Error(`Missing response field '${name}'`);
        return [name, toBorshValue(child, field)];
      }),
    );
  }
  if ("array" in schema) {
    const array =
      typeof value === "string" && schema.array.type === "u8"
        ? Array.from(ethers.getBytes(value))
        : value instanceof Uint8Array
          ? Array.from(value)
          : value;
    if (Array.isArray(array)) {
      return (array as BorshValue[]).map((element) => toBorshValue(schema.array.type, element));
    }
  }
  if ("option" in schema && value !== null) return toBorshValue(schema.option, value);
  if ("enum" in schema && typeof value === "object" && value !== null) {
    const variant = schema.enum.find((item) =>
      Object.keys(item.struct).some((key) => Object.hasOwn(value, key)),
    );
    if (variant !== undefined) return toBorshValue(variant, value);
  }
  return value;
}

/**
 * Encode ABI-decoded output using the request's native Borsh response schema.
 *
 * @param schema - Native schema, JSON text, or NUL-padded on-chain JSON.
 * @param output - Named decoded EVM values.
 * @returns Unpadded Borsh bytes.
 * @throws {Error} If conversion loses integer precision or Borsh rejects the input.
 */
export function serializeRespondOutput(
  schema: RespondSchemaInput,
  output: AbiDecodedOutput,
): Uint8Array {
  const parsed = respondSchema(schema);
  return compactSerialize(parsed, toBorshValue(parsed, output));
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
  readonly respondSerializationSchema: RespondSchemaInput;
}

/** The string default the MPC synthesises for an execution without call output. */
const NON_FUNCTION_CALL_SUCCESS = "non_function_call_success";

/**
 * The per-field values the MPC synthesises for an execution without call
 * output (its `default_value_for_kind`): `true` for a bool field,
 * {@link NON_FUNCTION_CALL_SUCCESS} for a string field.
 *
 * @param schema - The respondSerializationSchema.
 * @returns The synthesised values keyed by field name.
 * @throws {Error} If the schema is one {@link serializeRespondOutput}
 *   rejects, or a field is of any other kind.
 */
function nonFunctionCallDefaults(schema: RespondSchemaInput): AbiDecodedOutput {
  const parsed = respondSchema(schema);
  if (typeof parsed === "string" || !("struct" in parsed)) {
    throw new Error("Non-function-call defaults require a Borsh struct");
  }
  const output: AbiDecodedOutput = {};
  for (const [name, type] of Object.entries(parsed.struct)) {
    if (type === "bool") output[name] = true;
    else if (type === "string") output[name] = NON_FUNCTION_CALL_SUCCESS;
    else throw new Error(`Response field '${name}' has no non-function-call default`);
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
 *   `"non_function_call_success"`, any other kind
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

// ===========================================================================
// Helpers from here down. The exports above are the whole public surface:
// everything below serves them.
// ===========================================================================

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
 * ({@link deserializeEvmOutput} decodes nothing and
 * {@link executedEvmRespondOutput} synthesises defaults for a void call).
 *
 * @param schema - The schema as JSON text, packed bytes, or a field array.
 * @returns The schema's fields, names and type strings unvalidated beyond shape.
 * @throws {Error} If the schema is not an array of uniquely named fields.
 */
function parseSchemaShape(schema: EvmSchemaInput): EvmSchemaField[] {
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
    const { name, type } = raw as Record<string, unknown>;
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
    return { name, type };
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
