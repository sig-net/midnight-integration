// Table-driven tests for the headline abi-serde functions.
//
// deserializeEvmOutput: golden against ethers itself. Every case ENCODES the
// values with ethers' canonical AbiCoder, then decodes through our function,
// so the tables prove faithful round-trips through the real ABI grammar
// (including types outside the Compact vocabulary: signed ints, tuples,
// unbounded arrays, exactly what the MPC's alloy delegation accepts).
//
// serializeRespondOutput: byte-exact hex pins. The expected bytes follow the
// builtin serialize<T, N> layout verified against COMPILED circuits by
// @sig-net/midnight-serde's fixture suite and the serde-builtin experiment,
// so these tables transitively pin the wire format a Compact contract reads
// with deserialize<T, N>.
//
// executedEvmRespondOutput, isEvmContractCall and evmTraceOutputFromCallFrame:
// the MPC's own build_serialized_output, is_contract_call and
// trace_output_to_bytes test cases (bracketed in each row name) under the
// Midnight respond format, plus a row for every other branch and error of
// each rule.

import { ethers } from "ethers";
import { describe, expect, it } from "vitest";

import {
  type AbiDecodedOutput,
  type AbiSchema,
  type AbiSchemaInput,
  deserializeEvmOutput,
  type EvmSchemaInput,
  type EvmTraceOutput,
  evmTraceOutputFromCallFrame,
  EvmTraceOutputKind,
  executedEvmRespondOutput,
  isEvmContractCall,
  type JsonValue,
  type RespondPathSchemas,
  serializeRespondOutput,
} from "../src/index.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** A schema as the NUL-padded fixed-width bytes the chain carries. */
const nulPadded = (schema: unknown, width: number): Uint8Array => {
  const json = new TextEncoder().encode(JSON.stringify(schema));
  if (json.length > width) throw new Error("test schema wider than pad width");
  const out = new Uint8Array(width);
  out.set(json);
  return out;
};

const ADDRESS = "0x1111111111111111111111111111111111111102";

// ===========================================================================
// deserializeEvmOutput
// ===========================================================================

describe("deserializeEvmOutput: ethers round-trips", () => {
  const cases: {
    name: string;
    schema: { name: string; type: string }[];
    encoded: unknown[];
    expected: AbiDecodedOutput;
  }[] = [
    {
      name: "bool true",
      schema: [{ name: "success", type: "bool" }],
      encoded: [true],
      expected: { success: true },
    },
    {
      name: "bool false",
      schema: [{ name: "success", type: "bool" }],
      encoded: [false],
      expected: { success: false },
    },
    {
      name: "uint256 max",
      schema: [{ name: "amount", type: "uint256" }],
      encoded: [(1n << 256n) - 1n],
      expected: { amount: (1n << 256n) - 1n },
    },
    {
      name: "uint8",
      schema: [{ name: "small", type: "uint8" }],
      encoded: [255n],
      expected: { small: 255n },
    },
    {
      name: "address (ethers checksums it)",
      schema: [{ name: "to", type: "address" }],
      encoded: [ADDRESS],
      expected: { to: ethers.getAddress(ADDRESS) },
    },
    {
      name: "bytes32 (hex string form)",
      schema: [{ name: "hash", type: "bytes32" }],
      encoded: ["0x" + "ab".repeat(32)],
      expected: { hash: "0x" + "ab".repeat(32) },
    },
    {
      name: "int256 negative (outside the Compact vocabulary, valid ABI)",
      schema: [{ name: "delta", type: "int256" }],
      encoded: [-1n],
      expected: { delta: -1n },
    },
    {
      name: "string",
      schema: [{ name: "note", type: "string" }],
      encoded: ["hello midnight"],
      expected: { note: "hello midnight" },
    },
    {
      name: "dynamic bytes",
      schema: [{ name: "blob", type: "bytes" }],
      encoded: ["0xdeadbeef"],
      expected: { blob: "0xdeadbeef" },
    },
    {
      name: "unbounded uint256[] (ethers Result flattens to a plain array)",
      schema: [{ name: "xs", type: "uint256[]" }],
      encoded: [[1n, 2n, 3n]],
      expected: { xs: [1n, 2n, 3n] },
    },
    {
      name: "tuple (uint256,bool) flattens to a plain array",
      schema: [{ name: "pair", type: "(uint256,bool)" }],
      encoded: [[42n, true]],
      expected: { pair: [42n, true] },
    },
    {
      name: "multi-field mixed schema keeps declaration order by name",
      schema: [
        { name: "ok", type: "bool" },
        { name: "amount", type: "uint128" },
        { name: "to", type: "address" },
      ],
      encoded: [true, 123456789n, ADDRESS],
      expected: { ok: true, amount: 123456789n, to: ethers.getAddress(ADDRESS) },
    },
  ];

  it.each(cases)("$name", ({ schema, encoded, expected }) => {
    const callResult = coder.encode(
      schema.map((f) => f.type),
      encoded,
    );
    expect(deserializeEvmOutput(schema, callResult)).toEqual(expected);
  });
});

describe("deserializeEvmOutput: schema input forms are equivalent", () => {
  const schema = [
    { name: "ok", type: "bool" },
    { name: "amount", type: "uint256" },
  ];
  const callResult = coder.encode(["bool", "uint256"], [true, 4242n]);
  const expected = { ok: true, amount: 4242n };

  const forms: { name: string; input: EvmSchemaInput }[] = [
    { name: "typed array", input: schema },
    { name: "JSON string", input: JSON.stringify(schema) },
    { name: "raw JSON bytes", input: new TextEncoder().encode(JSON.stringify(schema)) },
    { name: "NUL-padded on-chain bytes", input: nulPadded(schema, 128) },
  ];

  it.each(forms)("$name", ({ input }) => {
    expect(deserializeEvmOutput(input, callResult)).toEqual(expected);
  });
});

describe("deserializeEvmOutput: empty schemas decode to no values", () => {
  // A plain transfer has no call output: every empty-schema form yields {}.
  const forms: { name: string; input: EvmSchemaInput }[] = [
    { name: "empty typed array", input: [] },
    { name: "empty-array JSON text", input: "[]" },
    { name: "blank text", input: "  " },
    { name: "an unset all-NUL on-chain field", input: new Uint8Array(34) },
  ];

  it.each(forms)("$name", ({ input }) => {
    expect(deserializeEvmOutput(input, "0x")).toEqual({});
  });
});

describe("deserializeEvmOutput: rejections", () => {
  const good = coder.encode(["bool"], [true]);
  const cases: {
    name: string;
    schema: EvmSchemaInput;
    callResult?: string;
    error?: RegExp;
  }[] = [
    {
      name: "unknown type string (rejected by ethers, the grammar authority)",
      schema: [{ name: "x", type: "banana" }],
      callResult: good,
    },
    {
      name: "'field' is not an ABI type (respond-side only)",
      schema: [{ name: "x", type: "field" }],
      callResult: good,
    },
    {
      name: "schema JSON that is not an array",
      schema: '{"name":"x","type":"bool"}',
      error: /JSON array/,
    },
    {
      name: "malformed schema JSON",
      schema: "not json at all",
      error: /JSON/i,
    },
    {
      name: "field without a name",
      schema: [{ type: "bool" }] as never,
      error: /needs a non-empty name/,
    },
    {
      name: "field that is not an object",
      schema: ["bool"] as never,
      error: /is not an object/,
    },
    {
      name: "field without a type",
      schema: [{ name: "x" }] as never,
      error: /needs a type/,
    },
    {
      name: "duplicate field names",
      schema: [
        { name: "x", type: "bool" },
        { name: "x", type: "uint256" },
      ],
      error: /duplicate field name 'x'/,
    },
    {
      name: "truncated call result (rejected by ethers)",
      schema: [{ name: "x", type: "uint256" }],
      callResult: "0x01",
    },
  ];

  it.each(cases)("$name", ({ schema, callResult, error }) => {
    // `/./` for the row whose message comes from ethers and is not pinned here.
    expect(() => deserializeEvmOutput(schema, callResult ?? good)).toThrow(error ?? /./);
  });
});

// ===========================================================================
// serializeRespondOutput
// ===========================================================================

describe("serializeRespondOutput: byte-exact layout pins (circuit-verified)", () => {
  const cases: {
    name: string;
    schema: AbiSchemaInput;
    output: AbiDecodedOutput;
    expectedHex: string;
  }[] = [
    {
      name: "bool true is one byte (the erc20-vault respond schema)",
      schema: [{ name: "success", type: "bool" }],
      output: { success: true },
      expectedHex: "01",
    },
    {
      name: "bool false",
      schema: [{ name: "success", type: "bool" }],
      output: { success: false },
      expectedHex: "00",
    },
    {
      name: "uint128 + uint64 pair: natural widths, LE, declaration order",
      schema: [
        { name: "a", type: "uint128" },
        { name: "b", type: "uint64" },
      ],
      output: { a: 4242n, b: 7n },
      expectedHex: "9210" + "00".repeat(14) + "07" + "00".repeat(7),
    },
    {
      name: "uint8 is a single byte",
      schema: [{ name: "small", type: "uint8" }],
      output: { small: 255n },
      expectedHex: "ff",
    },
    {
      name: "uint256 rides the 32-byte LE Field carrier",
      schema: [{ name: "v", type: "uint256" }],
      output: { v: 0x0102030405060708n },
      expectedHex: "0807060504030201" + "00".repeat(24),
    },
    {
      name: "field type is the same carrier",
      schema: [{ name: "v", type: "field" }],
      output: { v: 1n },
      expectedHex: "01" + "00".repeat(31),
    },
    {
      name: "address as 32-byte LE numeric",
      schema: [{ name: "to", type: "address" }],
      output: { to: "0x0000000000000000000000000000000000000102" },
      expectedHex: "0201" + "00".repeat(30),
    },
    {
      name: "bytes32 verbatim",
      schema: [{ name: "hash", type: "bytes32" }],
      output: { hash: "0x" + "ab".repeat(32) },
      expectedHex: "ab".repeat(32),
    },
    {
      name: "bytes4 verbatim",
      schema: [{ name: "sel", type: "bytes4" }],
      output: { sel: "0xdeadbeef" },
      expectedHex: "deadbeef",
    },
    {
      name: "string: Uint<64> LE length + payload padded to maxBytes",
      schema: [{ name: "s", type: "string", maxBytes: 32 }],
      output: { s: "hi" },
      expectedHex: "02" + "00".repeat(7) + "6869" + "00".repeat(30),
    },
    {
      name: "dynamic bytes: same convention",
      schema: [{ name: "blob", type: "bytes", maxBytes: 8 }],
      output: { blob: "0xdeadbeef" },
      expectedHex: "04" + "00".repeat(7) + "deadbeef" + "00".repeat(4),
    },
    {
      name: "uint128[]: Uint<64> LE count + maxItems elements at natural width",
      schema: [{ name: "xs", type: "uint128[]", maxItems: 3 }],
      output: { xs: [7n, 8n] },
      expectedHex:
        "02" + "00".repeat(7) + "07" + "00".repeat(15) + "08" + "00".repeat(15) + "00".repeat(16),
    },
    {
      name: "multi-field schema packs in declaration order with no gaps",
      schema: [
        { name: "ok", type: "bool" },
        { name: "amount", type: "uint128" },
        { name: "tag", type: "bytes4" },
      ],
      output: { ok: true, amount: 123456789n, tag: "0xcafebabe" },
      expectedHex: "01" + "15cd5b07" + "00".repeat(12) + "cafebabe",
    },
  ];

  it.each(cases)("$name", ({ schema, output, expectedHex }) => {
    const bytes = serializeRespondOutput(schema, output);
    expect(hex(bytes)).toBe(expectedHex);
    // UNBOUNDED: the packed size follows from the schema, nothing pads to 128.
    expect(bytes).toHaveLength(expectedHex.length / 2);
  });
});

describe("serializeRespondOutput: value-form coercions agree byte for byte", () => {
  const schema: AbiSchemaInput = [{ name: "v", type: "uint64" }];
  const expected = "05" + "00".repeat(7);

  const forms: { name: string; output: AbiDecodedOutput }[] = [
    { name: "bigint", output: { v: 5n } },
    { name: "number", output: { v: 5 } },
    { name: "decimal string", output: { v: "5" } },
    { name: "hex string", output: { v: "0x5" } },
  ];

  it.each(forms)("$name", ({ output }) => {
    expect(hex(serializeRespondOutput(schema, output))).toBe(expected);
  });

  it("bytes accept Uint8Array and hex string equally", () => {
    const s: AbiSchemaInput = [{ name: "hash", type: "bytes32" }];
    const asHex = serializeRespondOutput(s, { hash: "0x" + "5e".repeat(32) });
    const asBytes = serializeRespondOutput(s, { hash: new Uint8Array(32).fill(0x5e) });
    expect(hex(asHex)).toBe(hex(asBytes));
  });
});

describe("serializeRespondOutput: schema input forms are equivalent", () => {
  const schema = [{ name: "success", type: "bool" }];
  const output = { success: true };

  const forms: { name: string; input: AbiSchemaInput }[] = [
    { name: "typed array", input: schema as AbiSchemaInput },
    { name: "JSON string", input: JSON.stringify(schema) },
    { name: "NUL-padded on-chain bytes", input: nulPadded(schema, 64) },
  ];

  it.each(forms)("$name", ({ input }) => {
    expect(hex(serializeRespondOutput(input, output))).toBe("01");
  });
});

describe("serializeRespondOutput: rejections", () => {
  const cases: {
    name: string;
    schema: AbiSchemaInput;
    output: AbiDecodedOutput;
    error: RegExp;
  }[] = [
    {
      name: "missing value for a schema field",
      schema: [{ name: "success", type: "bool" }],
      output: {},
      error: /missing value for 'success'/,
    },
    {
      // Also a compile error with the typed schema union, hence the cast:
      // this row pins the runtime rejection for JS/JSON callers.
      name: "signed integer types have no Compact carrier",
      schema: [{ name: "delta", type: "int64" }] as never,
      output: { delta: 1n },
      error: /no signed integers/,
    },
    {
      name: "uint widths between 249 and 255 have no carrier",
      schema: [{ name: "v", type: "uint250" }],
      output: { v: 1n },
      error: /'v' \(uint250\) has no respond carrier/,
    },
    {
      name: "non-whole-byte uint widths are rejected (uint7)",
      schema: [{ name: "v", type: "uint7" }],
      output: { v: 1n },
      error: /'v' \(uint7\) has no respond carrier.*multiples of 8/,
    },
    {
      name: "non-whole-byte uint widths are rejected inside arrays (uint12[])",
      schema: [{ name: "xs", type: "uint12[]", maxItems: 2 }],
      output: { xs: [1n] },
      error: /'xs' \(uint12\) has no respond carrier.*multiples of 8/,
    },
    {
      name: "bytes33 is not a valid bytesN",
      schema: [{ name: "v", type: "bytes33" }],
      output: { v: new Uint8Array(33) },
      error: /not a valid bytesN/,
    },
    {
      // Also a compile error with the typed schema union, hence the cast.
      name: "tuples are decode-side only",
      schema: [{ name: "pair", type: "(uint256,bool)" }] as never,
      output: { pair: [1n, true] },
      error: /unsupported type/,
    },
    {
      name: "string without maxBytes",
      schema: [{ name: "s", type: "string" }] as never,
      output: { s: "x" },
      error: /maxBytes.*required/,
    },
    {
      name: "array without maxItems",
      schema: [{ name: "xs", type: "uint64[]" }] as never,
      output: { xs: [1n] },
      error: /maxItems.*required/,
    },
    {
      name: "string with a non-positive maxBytes",
      schema: [{ name: "s", type: "string", maxBytes: 0 }] as never,
      output: { s: "x" },
      error: /maxBytes.*positive integer/,
    },
    {
      name: "array with a fractional maxItems",
      schema: [{ name: "xs", type: "uint64[]", maxItems: 2.5 }] as never,
      output: { xs: [1n] },
      error: /maxItems.*positive integer/,
    },
    {
      name: "oversized string payload is never truncated",
      schema: [{ name: "s", type: "string", maxBytes: 4 }],
      output: { s: "toolong" },
      error: /maxBytes is 4/,
    },
    {
      name: "oversized array is never truncated",
      schema: [{ name: "xs", type: "uint64[]", maxItems: 1 }],
      output: { xs: [1n, 2n] },
      error: /maxItems is 1/,
    },
    {
      name: "negative value for an unsigned carrier",
      schema: [{ name: "v", type: "uint64" }],
      output: { v: -1n },
      error: /negative/,
    },
    {
      name: "uint value above its width",
      schema: [{ name: "v", type: "uint8" }],
      output: { v: 256n },
      error: /exceeds Uint<8>/,
    },
    {
      name: "uint256 value at the Field modulus",
      schema: [{ name: "v", type: "uint256" }],
      output: {
        v: 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n,
      },
      error: /Field modulus/,
    },
    {
      name: "address value above 2^160",
      schema: [{ name: "to", type: "address" }],
      output: { to: 1n << 160n },
      error: /exceeds an address/,
    },
    {
      name: "bytesN value of the wrong width",
      schema: [{ name: "hash", type: "bytes32" }],
      output: { hash: "0xdeadbeef" },
      error: /exactly 32 bytes/,
    },
    {
      name: "bool field given a non-boolean",
      schema: [{ name: "ok", type: "bool" }],
      output: { ok: 1n },
      error: /expects a boolean/,
    },
    {
      name: "array field given a scalar",
      schema: [{ name: "xs", type: "uint64[]", maxItems: 2 }],
      output: { xs: 1n },
      error: /expects an array/,
    },
    {
      name: "non-integer string for a numeric carrier",
      schema: [{ name: "v", type: "uint64" }],
      output: { v: "not-a-number" },
      error: /cannot parse/,
    },
    {
      name: "non-integer value for a numeric carrier",
      schema: [{ name: "v", type: "uint64" }],
      output: { v: true },
      error: /expected an integer-like value/,
    },
    {
      name: "non-bytes value for a bytesN carrier",
      schema: [{ name: "hash", type: "bytes32" }],
      output: { hash: 42n },
      error: /expected bytes/,
    },
    {
      name: "non-string value for a string field",
      schema: [{ name: "s", type: "string", maxBytes: 8 }],
      output: { s: 42n },
      error: /expected a string/,
    },
    {
      name: "schema field that is not an object",
      schema: [42] as never,
      output: {},
      error: /is not an object/,
    },
    {
      name: "empty respond schema array",
      schema: [],
      output: {},
      error: /respond schema is empty/,
    },
    {
      name: "an unset all-NUL respond schema field",
      schema: new Uint8Array(34),
      output: {},
      error: /respond schema is empty/,
    },
    {
      name: "malformed respond schema JSON",
      schema: "not json at all",
      output: {},
      error: /schema is not valid JSON/,
    },
    {
      name: "zero-padded uint width (uint08)",
      schema: [{ name: "v", type: "uint08" }] as never,
      output: { v: 1n },
      error: /unsupported type 'uint08'/,
    },
    {
      name: "zero-padded bytes width (bytes05)",
      schema: [{ name: "v", type: "bytes05" }] as never,
      output: { v: new Uint8Array(5) },
      error: /unsupported type 'bytes05'/,
    },
    {
      name: "a maxBytes capacity above the packed ceiling",
      schema: [{ name: "blob", type: "bytes", maxBytes: 100_000 }],
      output: { blob: new Uint8Array(1) },
      error: /above the 65536-byte ceiling/,
    },
    {
      name: "an array capacity above the packed ceiling",
      schema: [{ name: "xs", type: "bytes32[]", maxItems: 50_000_000 }],
      output: { xs: [] },
      error: /above the 65536-byte ceiling/,
    },
    {
      name: "a bytesN value that is not valid hex, named by field",
      schema: [{ name: "hash", type: "bytes32" }],
      output: { hash: "zz" },
      error: /'hash': not a valid 0x hex byte string/,
    },
    {
      name: "duplicate field names",
      schema: [
        { name: "x", type: "bool" },
        { name: "x", type: "bool" },
      ],
      output: { x: true },
      error: /duplicate field name 'x'/,
    },
  ];

  it.each(cases)("$name", ({ schema, output, error }) => {
    expect(() => serializeRespondOutput(schema, output)).toThrow(error);
  });
});

// ===========================================================================
// The full pipeline, as fakenet and verifying clients run it
// ===========================================================================

describe("serializeRespondOutput: packed-width ceiling boundary", () => {
  it("a schema packing to exactly the ceiling is accepted", () => {
    // 8 length-prefix bytes + 65528 capacity = 65536, the ceiling itself.
    const packed = serializeRespondOutput([{ name: "blob", type: "bytes", maxBytes: 65_528 }], {
      blob: new Uint8Array([1]),
    });
    expect(packed.length).toBe(65_536);
  });
});

describe("pipeline: EVM output -> deserializeEvmOutput -> serializeRespondOutput", () => {
  it("the ERC20 transfer flow produces the exact respond byte", () => {
    // The vault's schema, both directions.
    const schema = '[{"name":"success","type":"bool"}]';
    const callResult = coder.encode(["bool"], [true]);

    const decoded = deserializeEvmOutput(schema, callResult);
    expect(decoded).toEqual({ success: true });

    const respond = serializeRespondOutput(schema, decoded);
    expect(hex(respond)).toBe("01");
  });

  it("decode schema may be broader than the respond schema (MPC-style subset)", () => {
    // Decode with a broad schema including an int256 the respond side never
    // touches, then respond with the Compact-carrier subset, fields matched
    // by name.
    const decodeSchema = [
      { name: "amount", type: "uint256" },
      { name: "delta", type: "int256" },
      { name: "ok", type: "bool" },
    ];
    const callResult = coder.encode(["uint256", "int256", "bool"], [4242n, -5n, true]);
    const decoded = deserializeEvmOutput(decodeSchema, callResult);
    expect(decoded).toEqual({ amount: 4242n, delta: -5n, ok: true });

    const respondSchema: AbiSchemaInput = [
      { name: "ok", type: "bool" },
      { name: "amount", type: "uint128" },
    ];
    const respond = serializeRespondOutput(respondSchema, decoded);
    expect(hex(respond)).toBe("01" + "9210" + "00".repeat(14));
  });
});

// ===========================================================================
// isEvmContractCall
// ===========================================================================

describe("isEvmContractCall: more than two input bytes, as the MPC decides", () => {
  const cases: { name: string; input: ethers.BytesLike; expected: boolean }[] = [
    {
      name: "no input bytes [is_contract_call_detects_calldata]",
      input: new Uint8Array(0),
      expected: false,
    },
    {
      name: "two zero bytes [is_contract_call_detects_calldata]",
      input: new Uint8Array(2),
      expected: false,
    },
    {
      name: "a selector and one byte [is_contract_call_detects_calldata]",
      input: new Uint8Array([0xa9, 0x05, 0x9c, 0xbb, 0x00]),
      expected: true,
    },
    { name: "empty hex, the calldata of a plain transfer", input: "0x", expected: false },
    { name: "one byte of hex input", input: "0x00", expected: false },
    { name: "two bytes of hex input", input: "0xa905", expected: false },
    { name: "three bytes of hex input", input: "0xa9059c", expected: true },
    { name: "a bare selector", input: "0xa9059cbb", expected: true },
    {
      name: "the two ASCII bytes of the text 0x",
      input: new Uint8Array([0x30, 0x78]),
      expected: false,
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(isEvmContractCall(input)).toBe(expected);
  });

  it("rejects input that is not 0x hex", () => {
    expect(() => isEvmContractCall("0xzz")).toThrow();
  });
});

// ===========================================================================
// executedEvmRespondOutput
// ===========================================================================

const BOOL_SCHEMA: AbiSchema = [{ name: "success", type: "bool" }];
const STRING_SCHEMA: AbiSchema = [{ name: "message", type: "string", maxBytes: 32 }];
const UINT64_SCHEMA: AbiSchema = [{ name: "amount", type: "uint64" }];
const UINT256_SCHEMA: AbiSchema = [{ name: "amount", type: "uint256" }];

/** A plain transfer's request: the vault-style bool schema in both directions. */
const PLAIN_TRANSFER_SCHEMAS: RespondPathSchemas = {
  outputDeserializationSchema: BOOL_SCHEMA,
  respondSerializationSchema: BOOL_SCHEMA,
};

/** A void call's request: nothing to decode, a bool to respond with. */
const VOID_CALL_SCHEMAS: RespondPathSchemas = {
  outputDeserializationSchema: "[]",
  respondSerializationSchema: BOOL_SCHEMA,
};

const NOT_TRACED: EvmTraceOutput = { kind: EvmTraceOutputKind.NotTraced };
const NO_RETURN_DATA: EvmTraceOutput = { kind: EvmTraceOutputKind.NoReturnData };

/** The UTF-8 bytes of the MPC's synthesised string default, `non_function_call_success` (25 bytes). */
const NON_FUNCTION_CALL_SUCCESS_HEX = "6e6f6e5f66756e6374696f6e5f63616c6c5f73756363657373";

describe("executedEvmRespondOutput: the bytes the MPC attests", () => {
  const cases: {
    name: string;
    schemas: RespondPathSchemas;
    isContractCall: boolean;
    trace: EvmTraceOutput;
    expectedHex: string;
  }[] = [
    {
      name: "plain transfer under a bool field synthesises true [build_serialized_output_non_contract_call_uses_defaults]",
      schemas: PLAIN_TRANSFER_SCHEMAS,
      isContractCall: false,
      trace: NOT_TRACED,
      expectedHex: "01",
    },
    {
      name: "plain transfer never parses its output schema [build_serialized_output_fab_non_contract_default_skips_output_schema]",
      schemas: { ...PLAIN_TRANSFER_SCHEMAS, outputDeserializationSchema: "not JSON" },
      isContractCall: false,
      trace: NOT_TRACED,
      expectedHex: "01",
    },
    {
      name: "plain transfer ignores a trace it was given",
      schemas: PLAIN_TRANSFER_SCHEMAS,
      isContractCall: false,
      trace: { kind: EvmTraceOutputKind.Output, returnData: coder.encode(["bool"], [false]) },
      expectedHex: "01",
    },
    {
      name: "plain transfer under a string field fills its maxBytes buffer",
      schemas: { ...PLAIN_TRANSFER_SCHEMAS, respondSerializationSchema: STRING_SCHEMA },
      isContractCall: false,
      trace: NOT_TRACED,
      expectedHex: "1900000000000000" + NON_FUNCTION_CALL_SUCCESS_HEX + "00".repeat(7),
    },
    {
      name: "plain transfer under a string field of exactly the default's length",
      schemas: {
        ...PLAIN_TRANSFER_SCHEMAS,
        respondSerializationSchema: [{ name: "message", type: "string", maxBytes: 25 }],
      },
      isContractCall: false,
      trace: NOT_TRACED,
      expectedHex: "1900000000000000" + NON_FUNCTION_CALL_SUCCESS_HEX,
    },
    {
      name: "plain transfer under bool and string fields keeps declaration order",
      schemas: {
        ...PLAIN_TRANSFER_SCHEMAS,
        respondSerializationSchema: [...BOOL_SCHEMA, ...STRING_SCHEMA],
      },
      isContractCall: false,
      trace: NOT_TRACED,
      expectedHex: "01" + "1900000000000000" + NON_FUNCTION_CALL_SUCCESS_HEX + "00".repeat(7),
    },
    {
      name: "void call without return data synthesises defaults [build_serialized_output_fab_void_call_uses_default]",
      schemas: VOID_CALL_SCHEMAS,
      isContractCall: true,
      trace: NO_RETURN_DATA,
      expectedHex: "01",
    },
    {
      name: "void call under empty output schema bytes [build_serialized_output_accepts_missing_trace_output_for_empty_schema_bytes]",
      schemas: { ...VOID_CALL_SCHEMAS, outputDeserializationSchema: new Uint8Array(0) },
      isContractCall: true,
      trace: NO_RETURN_DATA,
      expectedHex: "01",
    },
    {
      name: "void call under an unset all-NUL on-chain output schema",
      schemas: { ...VOID_CALL_SCHEMAS, outputDeserializationSchema: new Uint8Array(34) },
      isContractCall: true,
      trace: NO_RETURN_DATA,
      expectedHex: "01",
    },
    {
      name: "void call with empty hex return data [build_serialized_output_accepts_explicit_empty_trace_output_for_empty_schema]",
      schemas: VOID_CALL_SCHEMAS,
      isContractCall: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: "0x" },
      expectedHex: "01",
    },
    {
      name: "void call with empty byte return data, string respond field",
      schemas: { ...VOID_CALL_SCHEMAS, respondSerializationSchema: STRING_SCHEMA },
      isContractCall: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: new Uint8Array(0) },
      expectedHex: "1900000000000000" + NON_FUNCTION_CALL_SUCCESS_HEX + "00".repeat(7),
    },
    {
      name: "contract call returning bool true decodes [build_serialized_output_fab_contract_bool]",
      schemas: PLAIN_TRANSFER_SCHEMAS,
      isContractCall: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: coder.encode(["bool"], [true]) },
      expectedHex: "01",
    },
    {
      name: "contract call returning bool false decodes, never defaults",
      schemas: PLAIN_TRANSFER_SCHEMAS,
      isContractCall: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: coder.encode(["bool"], [false]) },
      expectedHex: "00",
    },
    {
      name: "contract call returning uint64 decodes to its 8 LE bytes",
      schemas: {
        outputDeserializationSchema: UINT64_SCHEMA,
        respondSerializationSchema: UINT64_SCHEMA,
      },
      isContractCall: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: coder.encode(["uint64"], [12_345n]) },
      expectedHex: "3930000000000000",
    },
    {
      name: "contract call returning uint256 decodes to a LE Field [build_serialized_output_decodes_contract_call]",
      schemas: {
        outputDeserializationSchema: UINT256_SCHEMA,
        respondSerializationSchema: UINT256_SCHEMA,
      },
      isContractCall: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: coder.encode(["uint256"], [12_345n]) },
      expectedHex: "3930" + "00".repeat(30),
    },
    {
      name: "contract call returning a string decodes into its maxBytes buffer [all_response_formats_share_evm_decode_acceptance]",
      schemas: {
        outputDeserializationSchema: [{ name: "message", type: "string" }],
        respondSerializationSchema: STRING_SCHEMA,
      },
      isContractCall: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: coder.encode(["string"], ["hello"]) },
      expectedHex: "0500000000000000" + "68656c6c6f" + "00".repeat(27),
    },
  ];

  it.each(cases)("$name", ({ schemas, isContractCall, trace, expectedHex }) => {
    expect(hex(executedEvmRespondOutput(schemas, isContractCall, trace))).toBe(expectedHex);
  });
});

describe("executedEvmRespondOutput: throws where the MPC refuses to attest", () => {
  const cases: {
    name: string;
    schemas: RespondPathSchemas;
    isContractCall: boolean;
    trace: EvmTraceOutput;
    error: RegExp;
  }[] = [
    {
      name: "plain transfer under a uint field has no default",
      schemas: { ...PLAIN_TRANSFER_SCHEMAS, respondSerializationSchema: UINT64_SCHEMA },
      isContractCall: false,
      trace: NOT_TRACED,
      error: /'amount' \(uint64\) has no non-function-call default/,
    },
    {
      name: "plain transfer under a bytes field has no default",
      schemas: {
        ...PLAIN_TRANSFER_SCHEMAS,
        respondSerializationSchema: [{ name: "blob", type: "bytes", maxBytes: 32 }],
      },
      isContractCall: false,
      trace: NOT_TRACED,
      error: /'blob' \(bytes\) has no non-function-call default/,
    },
    {
      name: "plain transfer under a string field too narrow for the default",
      schemas: {
        ...PLAIN_TRANSFER_SCHEMAS,
        respondSerializationSchema: [{ name: "message", type: "string", maxBytes: 24 }],
      },
      isContractCall: false,
      trace: NOT_TRACED,
      error: /payload is 25 bytes, maxBytes is 24/,
    },
    {
      name: "plain transfer under an empty respond schema",
      schemas: { ...PLAIN_TRANSFER_SCHEMAS, respondSerializationSchema: "[]" },
      isContractCall: false,
      trace: NOT_TRACED,
      error: /respond schema is empty/,
    },
    {
      name: "void call under empty respond schema bytes [build_serialized_output_rejects_empty_byte_response_schema]",
      schemas: { ...VOID_CALL_SCHEMAS, respondSerializationSchema: new Uint8Array(0) },
      isContractCall: true,
      trace: NO_RETURN_DATA,
      error: /respond schema is empty/,
    },
    {
      name: "void call under a uint respond field has no default",
      schemas: { ...VOID_CALL_SCHEMAS, respondSerializationSchema: UINT64_SCHEMA },
      isContractCall: true,
      trace: NO_RETURN_DATA,
      error: /'amount' \(uint64\) has no non-function-call default/,
    },
    {
      name: "empty output schema but the call returned data [build_serialized_output_rejects_output_when_schema_declares_no_values]",
      schemas: { ...VOID_CALL_SCHEMAS, outputDeserializationSchema: new Uint8Array(0) },
      isContractCall: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: coder.encode(["uint256"], [1n]) },
      error: /output schema declares no return values/,
    },
    {
      name: "non-empty output schema without return data [build_serialized_output_rejects_missing_trace_output_for_non_empty_schema]",
      schemas: {
        outputDeserializationSchema: UINT256_SCHEMA,
        respondSerializationSchema: UINT256_SCHEMA,
      },
      isContractCall: true,
      trace: NO_RETURN_DATA,
      error: /no return data for a non-empty output schema/,
    },
    {
      name: "non-empty output schema not traced [build_serialized_output_requires_trace_for_contract_call]",
      schemas: {
        outputDeserializationSchema: UINT256_SCHEMA,
        respondSerializationSchema: UINT256_SCHEMA,
      },
      isContractCall: true,
      trace: NOT_TRACED,
      error: /needs its trace/,
    },
    {
      name: "empty output schema not traced",
      schemas: VOID_CALL_SCHEMAS,
      isContractCall: true,
      trace: NOT_TRACED,
      error: /needs its trace/,
    },
    {
      name: "non-empty output schema with empty return data fails the ABI decode",
      schemas: PLAIN_TRANSFER_SCHEMAS,
      isContractCall: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: "0x" },
      error: /data out-of-bounds/,
    },
    {
      name: "a contract call's malformed output schema",
      schemas: { ...PLAIN_TRANSFER_SCHEMAS, outputDeserializationSchema: "not JSON" },
      isContractCall: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: coder.encode(["bool"], [true]) },
      error: /schema is not valid JSON/,
    },
  ];

  it.each(cases)("$name", ({ schemas, isContractCall, trace, error }) => {
    expect(() => executedEvmRespondOutput(schemas, isContractCall, trace)).toThrow(error);
  });
});

// ===========================================================================
// evmTraceOutputFromCallFrame
// ===========================================================================

describe("evmTraceOutputFromCallFrame: the MPC's reading of a callTracer top frame", () => {
  const cases: { name: string; frame: JsonValue; expected: EvmTraceOutput }[] = [
    {
      name: "a call's output decodes to its return data [parses_successful_call_output]",
      frame: { type: "CALL", output: "0x" + "00".repeat(31) + "01" },
      expected: {
        kind: EvmTraceOutputKind.Output,
        returnData: new Uint8Array([...new Uint8Array(31), 1]),
      },
    },
    {
      name: "no output field is no return data [returns_none_when_output_missing_and_no_error]",
      frame: { type: "CALL" },
      expected: { kind: EvmTraceOutputKind.NoReturnData },
    },
    {
      name: "an empty 0x output is empty return data",
      frame: { type: "CALL", output: "0x" },
      expected: { kind: EvmTraceOutputKind.Output, returnData: new Uint8Array(0) },
    },
    {
      name: "an empty string output is empty return data",
      frame: { type: "CALL", output: "" },
      expected: { kind: EvmTraceOutputKind.Output, returnData: new Uint8Array(0) },
    },
    {
      name: "an unprefixed hex output decodes",
      frame: { type: "CALL", output: "a9059cbb" },
      expected: {
        kind: EvmTraceOutputKind.Output,
        returnData: new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]),
      },
    },
    {
      name: "uppercase hex digits decode",
      frame: { type: "CALL", output: "0xA9059CBB" },
      expected: {
        kind: EvmTraceOutputKind.Output,
        returnData: new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]),
      },
    },
    {
      name: "a null output is no return data",
      frame: { type: "CALL", output: null },
      expected: { kind: EvmTraceOutputKind.NoReturnData },
    },
    {
      name: "a numeric output is no return data",
      frame: { type: "CALL", output: 1 },
      expected: { kind: EvmTraceOutputKind.NoReturnData },
    },
    {
      name: "an empty error is ignored",
      frame: { type: "CALL", error: "", output: "0x01" },
      expected: { kind: EvmTraceOutputKind.Output, returnData: new Uint8Array([1]) },
    },
    {
      name: "a non-string error is ignored",
      frame: { type: "CALL", error: { code: 3 }, output: "0x01" },
      expected: { kind: EvmTraceOutputKind.Output, returnData: new Uint8Array([1]) },
    },
    {
      name: "a type of any JSON kind is a call frame",
      frame: { type: null },
      expected: { kind: EvmTraceOutputKind.NoReturnData },
    },
  ];

  it.each(cases)("$name", ({ frame, expected }) => {
    expect(evmTraceOutputFromCallFrame(frame)).toEqual(expected);
  });
});

describe("evmTraceOutputFromCallFrame: refusals", () => {
  const cases: { name: string; frame: JsonValue; error: RegExp }[] = [
    {
      name: "a null result [bails_when_trace_result_is_null]",
      frame: null,
      error: /is not a call frame/,
    },
    { name: "an array result", frame: [{ type: "CALL" }], error: /is not a call frame/ },
    { name: "a string result", frame: "0x01", error: /is not a call frame/ },
    {
      name: "an object without a type [bails_when_trace_result_has_no_call_type]",
      frame: {},
      error: /has no call frame `type`/,
    },
    {
      name: "a revert names its reason [bails_on_revert_with_reason]",
      frame: { type: "CALL", error: "execution reverted", revertReason: "InsufficientBalance" },
      error: /reverted: execution reverted \(InsufficientBalance\)/,
    },
    {
      name: "an error without a reason",
      frame: { type: "CALL", error: "out of gas" },
      error: /errored: out of gas$/,
    },
    {
      name: "an error with an empty reason",
      frame: { type: "CALL", error: "execution reverted", revertReason: "" },
      error: /errored: execution reverted$/,
    },
    {
      name: "an error refuses even beside an output",
      frame: { type: "CALL", error: "execution reverted", output: "0x01" },
      error: /errored: execution reverted$/,
    },
    {
      name: "an odd-length output",
      frame: { type: "CALL", output: "0x012" },
      error: /output is not hex/,
    },
    {
      name: "a non-hex output",
      frame: { type: "CALL", output: "0xzz" },
      error: /output is not hex/,
    },
    {
      name: "an uppercase 0X prefix is not stripped",
      frame: { type: "CALL", output: "0X01" },
      error: /output is not hex/,
    },
  ];

  it.each(cases)("$name", ({ frame, error }) => {
    expect(() => evmTraceOutputFromCallFrame(frame)).toThrow(error);
  });
});
