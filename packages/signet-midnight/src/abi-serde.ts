import { type BorshValue, compactSerialize, type Schema } from "@sig-net/midnight-serde";
import { ethers } from "ethers";

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

/**
 * One field of an outputDeserializationSchema: `type` is an ABI type string
 * `ethers.ParamType` accepts. {@link deserializeEvmOutput} decodes every
 * such type, while the respond side ({@link deriveRespondSchema}) accepts
 * only the {@link EvmOutputTypeKind} subset, matched on the raw string.
 */
export interface EvmSchemaField {
  name: string;
  type: string;
}

/** Any form an outputDeserializationSchema arrives in: parsed, JSON text, or NUL-padded raw bytes. */
export type EvmSchemaInput = readonly EvmSchemaField[] | string | Uint8Array;

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

/**
 * Decoded output values, keyed by schema field name. Numerics are bigint,
 * bools boolean, address/bytesN/bytes/string are the forms ethers produces
 * (hex or text strings) or Uint8Array, arrays are plain arrays.
 * {@link serializeRespondOutput} additionally accepts plain numbers and
 * numeric strings for `uint256`, the forms indexer JSON typically yields.
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
 * shape only, so it decodes ABI types the respond side refuses. An empty
 * schema decodes to an empty object. Returns a plain object (never an
 * ethers `Result`), so it survives JSON round-trips and structural
 * comparison.
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
  return Object.fromEntries(
    fields.map((field, i): [string, AbiDecodedValue] => [
      field.name,
      toPlainValue(decoded[i], field.name),
    ]),
  );
}

// ---------------------------------------------------------------------------
// 2. decoded values -> respond bytes  (Borsh schema derived from the output schema)
// ---------------------------------------------------------------------------

/**
 * The ABI output types the MPC attests, and what each maps to. The respond
 * bytes are the Borsh serialisation of a struct with one member per output
 * field, in schema order, typed by this mapping:
 *
 * - {@link EvmOutputTypeKind.Bool}: ABI `bool`, Borsh `bool`, Compact `Boolean` (1 byte).
 * - {@link EvmOutputTypeKind.Uint256}: ABI `uint256`, Borsh `[u8; 32]`
 *   holding the value LITTLE-endian, the byte order of every Borsh and
 *   Compact integer, Compact `Bytes<32>` (32 bytes). A circuit that wants a
 *   number narrows it with `checkedTruncationU128`, which aborts above
 *   2^128 - 1. The ABI wire word is big-endian: the MPC reverses it once,
 *   here, so no circuit has to.
 * - {@link EvmOutputTypeKind.Address}: ABI `address`, Borsh `[u8; 20]`
 *   holding the address bytes, Compact `Bytes<20>` (20 bytes).
 * - {@link EvmOutputTypeKind.FixedBytes}: ABI `bytes1` to `bytes32`, Borsh
 *   `[u8; N]`, Compact `Bytes<N>` (N bytes).
 *
 * Every other ABI type is unsupported: the MPC drops a request whose output
 * schema names one, and {@link deriveRespondSchema} throws on it.
 */
export enum EvmOutputTypeKind {
  Bool = "bool",
  Uint256 = "uint256",
  Address = "address",
  FixedBytes = "bytesN",
}

/** The byte width of an ABI word, and of the Borsh array a `uint256` output maps to. */
const ABI_WORD_BYTES = 32;

/** The byte width of an EVM address, and of the Borsh array an `address` output maps to. */
const EVM_ADDRESS_BYTES = 20;

/**
 * Classify an ABI type string into the supported output subset. The match is
 * on the raw string, so `uint` is unsupported although the ABI library reads
 * it as `uint256`: the MPC matches the same raw string.
 *
 * @param type - The ABI type string of an output schema field.
 * @returns The field's kind and respond byte width, or `undefined` for an unsupported type.
 */
function classifyEvmOutputType(
  type: string,
): { readonly kind: EvmOutputTypeKind; readonly bytes: number } | undefined {
  if (type === "bool") return { kind: EvmOutputTypeKind.Bool, bytes: 1 };
  if (type === "uint256") return { kind: EvmOutputTypeKind.Uint256, bytes: ABI_WORD_BYTES };
  if (type === "address") return { kind: EvmOutputTypeKind.Address, bytes: EVM_ADDRESS_BYTES };
  const fixedBytes = /^bytes([1-9]|[12][0-9]|3[0-2])$/.exec(type);
  if (fixedBytes !== null) {
    return { kind: EvmOutputTypeKind.FixedBytes, bytes: Number(fixedBytes[1]) };
  }
  return undefined;
}

/**
 * The fields of an outputDeserializationSchema whose ABI type is outside the
 * supported subset ({@link EvmOutputTypeKind}). The check itself never
 * throws on an unsupported type: an empty result means the MPC attests the
 * request, a non-empty one means it drops it.
 *
 * @param schema - The outputDeserializationSchema: parsed, JSON text, or the raw NUL-padded on-chain bytes.
 * @returns The unsupported fields in schema order, empty when every field is supported.
 * @throws {Error} If the schema is not an array of uniquely named fields (its shape, not its types).
 */
export function unsupportedEvmOutputFields(schema: EvmSchemaInput): EvmSchemaField[] {
  return parseSchemaShape(schema).filter(
    (field) => classifyEvmOutputType(field.type) === undefined,
  );
}

/** An output schema field with its {@link EvmOutputTypeKind} and respond byte width. */
interface ClassifiedEvmOutputField extends EvmSchemaField {
  readonly kind: EvmOutputTypeKind;
  readonly bytes: number;
}

/**
 * Parse an output schema and classify every field, refusing the schema as a
 * whole when any field is unsupported.
 *
 * @param schema - The outputDeserializationSchema: parsed, JSON text, or the raw NUL-padded on-chain bytes.
 * @returns The classified fields in schema order.
 * @throws {Error} If the schema is malformed or names an unsupported ABI type.
 */
function classifiedEvmOutputFields(schema: EvmSchemaInput): ClassifiedEvmOutputField[] {
  const fields = parseSchemaShape(schema);
  const unsupported = fields.filter((field) => classifyEvmOutputType(field.type) === undefined);
  if (unsupported.length > 0) {
    throw new Error(
      `respond output: unsupported ABI output type${unsupported.length > 1 ? "s" : ""} ` +
        unsupported.map((field) => `'${field.name}' (${field.type})`).join(", ") +
        ": the MPC attests bool, uint256, address and bytes1 to bytes32 only",
    );
  }
  return fields.flatMap((field) => {
    const classified = classifyEvmOutputType(field.type);
    return classified === undefined ? [] : [{ ...field, ...classified }];
  });
}

/**
 * The Borsh schema the respond bytes of an executed call are serialised
 * with: a struct with one member per output field, in schema order, each
 * typed by {@link EvmOutputTypeKind}. An empty output schema derives an
 * empty struct, which serialises to zero bytes. Borsh writes struct members
 * in the struct object's key order, which equals schema order because field
 * names are Solidity identifiers (see {@link parseSchemaShape}).
 *
 * @param schema - The outputDeserializationSchema: parsed, JSON text, or the raw NUL-padded on-chain bytes.
 * @returns The derived Borsh struct schema.
 * @throws {Error} If the schema is malformed or names an unsupported ABI type.
 */
export function deriveRespondSchema(schema: EvmSchemaInput): Schema {
  return {
    struct: Object.fromEntries(
      classifiedEvmOutputFields(schema).map((field) => [
        field.name,
        field.kind === EvmOutputTypeKind.Bool
          ? "bool"
          : { array: { type: "u8", len: field.bytes } },
      ]),
    ),
  };
}

/**
 * The byte width of the respond bytes an output schema derives: the sum of
 * its fields' widths under {@link EvmOutputTypeKind}, what a settle circuit
 * declares as its `Bytes<N>` output argument.
 *
 * @param schema - The outputDeserializationSchema: parsed, JSON text, or the raw NUL-padded on-chain bytes.
 * @returns The exact serialised width, 0 for an empty schema.
 * @throws {Error} If the schema is malformed or names an unsupported ABI type.
 */
export function respondOutputWidth(schema: EvmSchemaInput): number {
  return classifiedEvmOutputFields(schema).reduce((width, field) => width + field.bytes, 0);
}

/**
 * The 32-byte LITTLE-endian encoding of a `uint256` output value, as ethers
 * decodes it (bigint) or as indexer JSON renders it (a number or a decimal
 * string). This is the ABI wire word reversed: the Borsh integer byte order,
 * which a Compact `Uint<128>` reads directly.
 *
 * @param value - The decoded value.
 * @param name - The field name, for the error message.
 * @returns The value's 32 little-endian bytes.
 * @throws {RangeError} If the value is not an integer in `0 <= value < 2^256`.
 */
function uint256Word(value: AbiDecodedValue, name: string): number[] {
  if (typeof value !== "bigint" && typeof value !== "number" && typeof value !== "string") {
    throw new TypeError(`respond output: '${name}' (uint256) expects an integer`);
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new RangeError(`respond output: '${name}' (uint256) is not a safe integer`);
  }
  if (typeof value === "string" && !/^\s*\d+\s*$/.test(value)) {
    throw new RangeError(`respond output: '${name}' (uint256) is not a decimal integer string`);
  }
  const integer = BigInt(value);
  if (integer < 0n || integer >= 1n << 256n) {
    throw new RangeError(
      `respond output: '${name}' (uint256) ${String(integer)} is outside uint256`,
    );
  }
  return Array.from(ethers.getBytes(ethers.toBeHex(integer, ABI_WORD_BYTES))).reverse();
}

/**
 * The bytes of an `address` or `bytesN` output value, as ethers decodes it
 * (a hex string, checksummed for an address) or as bytes. Byte order is the
 * wire's: these are byte strings, not numbers.
 *
 * @param value - The decoded value.
 * @param field - The field, for the error message.
 * @returns The value's bytes, length-checked by Borsh against the schema.
 * @throws {TypeError} If the value is neither a hex string nor bytes.
 */
function byteString(value: AbiDecodedValue, field: EvmSchemaField): number[] {
  if (value instanceof Uint8Array) return Array.from(value);
  if (typeof value === "string") return Array.from(ethers.getBytes(value));
  throw new TypeError(`respond output: '${field.name}' (${field.type}) expects hex or bytes`);
}

/**
 * Serialise ABI-decoded output into the respond bytes the MPC attests: the
 * Borsh encoding of {@link deriveRespondSchema}'s struct over the output's
 * values. A `uint256` is carried whole as 32 little-endian bytes, so no
 * value is narrowed off chain: a circuit that wants a number narrows the
 * `Bytes<32>` with `checkedTruncationU128`.
 *
 * @param schema - The outputDeserializationSchema: parsed, JSON text, or the raw NUL-padded on-chain bytes.
 * @param output - The decoded values keyed by field name, as {@link deserializeEvmOutput} returns them.
 * @returns The unpadded respond bytes, {@link respondOutputWidth} long.
 * @throws {Error} If the schema is malformed or names an unsupported type, a
 *   field is missing from `output`, or a value is outside its type.
 */
export function serializeRespondOutput(
  schema: EvmSchemaInput,
  output: AbiDecodedOutput,
): Uint8Array {
  const values: Record<string, BorshValue> = Object.fromEntries(
    classifiedEvmOutputFields(schema).map((field): [string, BorshValue] => {
      const value = output[field.name];
      if (value === undefined) {
        throw new Error(`respond output: missing value for '${field.name}'`);
      }
      switch (field.kind) {
        case EvmOutputTypeKind.Bool:
          if (typeof value !== "boolean") {
            throw new TypeError(`respond output: '${field.name}' (bool) expects a boolean`);
          }
          return [field.name, value];
        case EvmOutputTypeKind.Uint256:
          return [field.name, uint256Word(value, field.name)];
        case EvmOutputTypeKind.Address:
        case EvmOutputTypeKind.FixedBytes:
          return [field.name, byteString(value, field)];
      }
    }),
  );
  return compactSerialize(deriveRespondSchema(schema), values);
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
 * Refuse return data that is not canonical ABI before it is decoded: whole
 * 32-byte words, at least one per declared field, a `bool` word of 0 or 1,
 * an `address` word with zero high bytes and a `bytesN` word zero-padded
 * after its N bytes. Words past the declared fields are not checked. The ABI
 * library decodes such data leniently (a `bool` word of 2 reads as true), so
 * the check sits here, where the MPC decides whether to attest.
 *
 * @param fields - The schema's classified fields, in order.
 * @param returnData - The traced return data, non-empty.
 * @throws {Error} If the data is not whole words, holds fewer words than
 *   fields, or a field's word is not canonical for its type.
 */
function checkCanonicalReturnData(
  fields: readonly ClassifiedEvmOutputField[],
  returnData: Uint8Array,
): void {
  if (returnData.length % ABI_WORD_BYTES !== 0) {
    throw new Error(
      `respond output: return data of ${String(returnData.length)} bytes is not whole ABI words`,
    );
  }
  const words = returnData.length / ABI_WORD_BYTES;
  if (words < fields.length) {
    throw new Error(
      `respond output: return data holds ${String(words)} word${words === 1 ? "" : "s"} but the output schema declares ${String(fields.length)} fields`,
    );
  }
  const isZero = (bytes: Uint8Array): boolean => bytes.every((byte) => byte === 0);
  fields.forEach((field, i) => {
    const word = returnData.subarray(i * ABI_WORD_BYTES, (i + 1) * ABI_WORD_BYTES);
    const last = word[ABI_WORD_BYTES - 1];
    const canonical =
      field.kind === EvmOutputTypeKind.Bool
        ? isZero(word.subarray(0, ABI_WORD_BYTES - 1)) && (last === 0 || last === 1)
        : field.kind === EvmOutputTypeKind.Address
          ? isZero(word.subarray(0, ABI_WORD_BYTES - EVM_ADDRESS_BYTES))
          : field.kind === EvmOutputTypeKind.FixedBytes
            ? isZero(word.subarray(field.bytes))
            : true;
    if (!canonical) {
      throw new Error(
        `respond output: '${field.name}' (${field.type}) word 0x${ethers.hexlify(word).slice(2)} is not canonical ABI`,
      );
    }
  });
}

/**
 * The exact respond output the MPC attests for an EVM transaction that
 * executed (the payload of an `OutputKind.executed` attestation), derived
 * from the request's outputDeserializationSchema alone. The schema and the
 * execution's return data MUST agree: an empty schema declares that the
 * execution returns nothing, a non-empty schema that it returns data.
 *
 * - Not a contract call (a plain transfer): there is no return data, so the
 *   schema must be empty and the output is EMPTY.
 * - A contract call whose trace carries no return data, or empty return
 *   data (`0x`): the schema must be empty and the output is EMPTY.
 * - A contract call that returned data: the schema must be non-empty, and
 *   the output is the return data decoded by {@link deserializeEvmOutput}
 *   and serialised by {@link serializeRespondOutput}.
 *
 * The schema's types are checked on every path, a plain transfer included,
 * so a request the MPC should have dropped never attests anything. A failed
 * or unviable execution is attested over an empty output instead, which
 * needs no call. An empty output under `executed` is therefore ordinary for
 * an empty schema: its settle circuit verifies at width 0 and must route on
 * the verified `outputKind`, never on the width.
 *
 * @param schema - The request's outputDeserializationSchema (a request record's field satisfies this).
 * @param isContractCall - Whether the transaction is a contract call, as {@link isEvmContractCall} decides it.
 * @param trace - The transaction's traced return data (`NotTraced` for an untraced plain transfer).
 * @returns The respond bytes, unpadded, empty for an empty schema.
 * @throws {Error} Exactly where the MPC refuses to attest an execution: a
 *   malformed schema or an unsupported output type, a contract call not
 *   traced, return data under an empty schema, no or empty return data
 *   under a non-empty schema, return data that is not canonical ABI
 *   ({@link checkCanonicalReturnData}) or that the schema cannot decode, and
 *   every {@link serializeRespondOutput} rejection.
 */
export function executedEvmRespondOutput(
  schema: EvmSchemaInput,
  isContractCall: boolean,
  trace: EvmTraceOutput,
): Uint8Array {
  const fields = classifiedEvmOutputFields(schema);
  const expectsOutput = fields.length > 0;
  if (!isContractCall) {
    if (expectsOutput) {
      throw new Error(
        "respond output: a plain transfer returns nothing, but the output schema declares return values",
      );
    }
    return new Uint8Array(0);
  }
  if (trace.kind === EvmTraceOutputKind.NotTraced) {
    throw new Error("respond output: a contract call's output needs its trace");
  }
  const returnData =
    trace.kind === EvmTraceOutputKind.Output
      ? ethers.getBytes(trace.returnData)
      : new Uint8Array(0);
  if (returnData.length === 0) {
    if (expectsOutput) {
      throw new Error(
        "respond output: the contract call returned no data, but the output schema declares return values",
      );
    }
    return new Uint8Array(0);
  }
  if (!expectsOutput) {
    throw new Error(
      "respond output: the contract call returned data, but the output schema declares no return values",
    );
  }
  checkCanonicalReturnData(fields, returnData);
  return serializeRespondOutput(schema, deserializeEvmOutput(schema, returnData));
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
 * The canonical text of an output schema: `JSON.stringify` of its fields
 * reduced to `{name, type}` in schema order, with no whitespace. A schema's
 * on-chain bytes must be exactly this text followed by NUL padding, so one
 * schema has exactly one byte form. Write a contract's schema literal with
 * this function's output.
 *
 * @param fields - The schema's fields in order.
 * @returns The canonical JSON text, `[]` for an empty schema.
 */
export function canonicalSchemaText(fields: readonly EvmSchemaField[]): string {
  return JSON.stringify(fields.map(({ name, type }) => ({ name, type })));
}

/**
 * Parse a schema's bytes, requiring the canonical form: the bytes before the
 * first NUL are exactly {@link canonicalSchemaText} of the fields they
 * encode, every byte from the first NUL on is NUL, and an empty schema is
 * `[]` or no bytes at all (an unset all-NUL field).
 *
 * @param bytes - The schema text's UTF-8 bytes, NUL-padded or not.
 * @returns The schema's fields.
 * @throws {Error} If the padding holds a non-NUL byte, the text is not JSON,
 *   the fields fail {@link checkSchemaFields}, or the text is not canonical.
 */
function parseCanonicalSchema(bytes: Uint8Array): EvmSchemaField[] {
  const nul = bytes.indexOf(0);
  const body = nul === -1 ? bytes : bytes.subarray(0, nul);
  if (nul !== -1 && bytes.subarray(nul).some((byte) => byte !== 0)) {
    throw new Error("schema: every byte from the first NUL on must be NUL");
  }
  if (body.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    throw new Error(`schema is not valid JSON (${String(error)})`, { cause: error });
  }
  const fields = checkSchemaFields(parsed);
  const canonical = new TextEncoder().encode(canonicalSchemaText(fields));
  if (canonical.length !== body.length || canonical.some((byte, i) => byte !== body[i])) {
    throw new Error(`schema is not canonical: expected exactly ${canonicalSchemaText(fields)}`);
  }
  return fields;
}

/**
 * A Solidity identifier, the only form a field name takes. A name outside
 * this grammar can start with a digit, and a JavaScript object orders
 * integer-like keys first, which would move the derived Borsh struct's
 * members out of schema order.
 */
const SOLIDITY_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The one identifier no field may use: assigning it on a JavaScript object
 * reaches the prototype accessor, so an output object cannot carry it.
 */
const PROTOTYPE_ACCESSOR_NAME = "__proto__";

/**
 * Parse a schema in any input form and check its SHAPE only: text and bytes
 * must be the canonical form ({@link parseCanonicalSchema}), and every form
 * passes {@link checkSchemaFields}. Whether a type is in the attested subset
 * is decided later, by {@link classifyEvmOutputType}. An empty schema is
 * valid here: {@link deserializeEvmOutput} decodes nothing from it and
 * {@link executedEvmRespondOutput} attests an empty output.
 *
 * @param schema - The schema as canonical JSON text, NUL-padded bytes, or a field array.
 * @returns The schema's fields, type strings as written.
 * @throws {Error} If the text or bytes are not canonical, or the fields fail {@link checkSchemaFields}.
 */
function parseSchemaShape(schema: EvmSchemaInput): EvmSchemaField[] {
  if (typeof schema === "string") {
    return parseCanonicalSchema(new TextEncoder().encode(schema));
  }
  if (schema instanceof Uint8Array) {
    return parseCanonicalSchema(schema);
  }
  return checkSchemaFields(schema);
}

/**
 * Check a parsed schema value's shape: an array of fields with unique
 * Solidity-identifier names and ABI type strings `ethers.ParamType` accepts.
 *
 * @param parsed - The schema as parsed JSON or a field array.
 * @returns The schema's fields, type strings as written.
 * @throws {Error} If the value is not an array of fields, a name is not a
 *   Solidity identifier or is `__proto__`, a name repeats, or a type is
 *   missing or not an ABI type.
 */
function checkSchemaFields(parsed: unknown): EvmSchemaField[] {
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
    if (!SOLIDITY_IDENTIFIER.test(name)) {
      throw new Error(`schema: field name '${name}' is not a Solidity identifier`);
    }
    if (name === PROTOTYPE_ACCESSOR_NAME) {
      throw new Error(`schema: field name '${name}' is refused`);
    }
    if (seen.has(name)) {
      throw new Error(`schema: duplicate field name '${name}'`);
    }
    seen.add(name);
    if (typeof type !== "string" || type.length === 0) {
      throw new Error(`schema: '${name}' needs a type`);
    }
    try {
      ethers.ParamType.from(type);
    } catch (error) {
      throw new Error(`schema: '${name}' has an invalid ABI type '${type}'`, { cause: error });
    }
    return { name, type };
  });
}
