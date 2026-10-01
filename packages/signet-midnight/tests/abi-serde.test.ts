import { ethers } from "ethers";
import { describe, expect, it } from "vitest";

import {
  type AbiDecodedOutput,
  deserializeEvmOutput,
  type EvmSchemaInput,
  type EvmTraceOutput,
  evmTraceOutputFromCallFrame,
  EvmTraceOutputKind,
  executedEvmRespondOutput,
  isEvmContractCall,
  type JsonValue,
  type RespondPathSchemas,
  type RespondSchemaInput,
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

const RESPONSE_SCHEMA = { struct: { success: "bool", amount: "u128" } };
const ABI_SCHEMA = [
  { name: "success", type: "bool" },
  { name: "amount", type: "uint256" },
];

describe("ABI values to native Borsh responses", () => {
  it.each([0n, 42n, (1n << 128n) - 1n])("checked uint256 to u128: %s", (amount) => {
    const output = deserializeEvmOutput(
      ABI_SCHEMA,
      coder.encode(["bool", "uint256"], [true, amount]),
    );
    const bytes = serializeRespondOutput(RESPONSE_SCHEMA, output);
    expect(bytes).toHaveLength(17);
    expect(bytes).toEqual(
      Uint8Array.from([
        1,
        ...Array.from({ length: 16 }, (_, i) => Number((amount >> BigInt(8 * i)) & 255n)),
      ]),
    );
  });
  it.each([-1n, 1n << 128n, (1n << 256n) - 1n])("rejects lossy narrowing: %s", (amount) => {
    expect(() => serializeRespondOutput(RESPONSE_SCHEMA, { success: true, amount })).toThrow(
      /does not fit Borsh u128/,
    );
  });
  const schemaForms: { name: string; schema: RespondSchemaInput }[] = [
    { name: "native", schema: RESPONSE_SCHEMA },
    { name: "JSON", schema: JSON.stringify(RESPONSE_SCHEMA) },
    { name: "padded bytes", schema: nulPadded(RESPONSE_SCHEMA, 128) },
    {
      name: "padded text",
      schema: new TextDecoder().decode(nulPadded(RESPONSE_SCHEMA, 128)),
    },
  ];
  it.each(schemaForms)("accepts $name schema", ({ schema }) => {
    expect(serializeRespondOutput(schema, { success: true, amount: 42n })).toEqual(
      Uint8Array.from([1, 42, ...new Array<number>(15).fill(0)]),
    );
  });
  it("maps numeric and byte array ABI values without a Compact schema restriction", () => {
    expect(
      serializeRespondOutput(
        {
          struct: {
            values: { array: { type: "u16" } },
            bytes: { array: { type: "u8", len: 2 } },
            text: "string",
          },
        },
        { values: [1n, 256n], bytes: "0xaabb", text: "x" },
      ),
    ).toEqual(Uint8Array.of(2, 0, 0, 0, 1, 0, 0, 1, 170, 187, 1, 0, 0, 0, 120));
  });
  it.each([256n, -1n, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe u8 conversion %s", (value) => {
    expect(() => serializeRespondOutput({ struct: { value: "u8" } }, { value })).toThrow();
  });
  it("rejects a missing field", () => {
    expect(() => serializeRespondOutput(RESPONSE_SCHEMA, { success: true })).toThrow(
      /Missing response field/,
    );
  });
  it.each(["", " ", "\t\n"])("rejects blank integer %j", (amount) => {
    expect(() => serializeRespondOutput(RESPONSE_SCHEMA, { success: true, amount })).toThrow(
      "Empty integer for u128",
    );
  });
  const invalidSchemas: { name: string; schema: RespondSchemaInput; error: string }[] = [
    { name: "empty text", schema: "", error: "Response schema is empty" },
    { name: "blank text", schema: " \t\n", error: "Response schema is empty" },
    { name: "NUL text", schema: "\0\0", error: "Response schema is empty" },
    { name: "NUL bytes", schema: new Uint8Array(4), error: "Response schema is empty" },
    { name: "invalid JSON text", schema: "{", error: "Response schema is not valid JSON" },
    {
      name: "invalid JSON bytes",
      schema: new TextEncoder().encode("{"),
      error: "Response schema is not valid JSON",
    },
  ];
  it.each(invalidSchemas)("rejects $name with schema context", ({ schema, error }) => {
    expect(() => serializeRespondOutput(schema, {})).toThrow(error);
  });
  const nativeCases: {
    name: string;
    schema: RespondSchemaInput;
    output: AbiDecodedOutput;
    expected: string;
  }[] = [
    { name: "empty struct", schema: { struct: {} }, output: {}, expected: "" },
    {
      name: "optional integer",
      schema: { struct: { amount: { option: "u16" } } },
      output: { amount: 256n },
      expected: "010001",
    },
    {
      name: "optional struct",
      schema: { option: { struct: { amount: "u16" } } },
      output: { amount: 256n },
      expected: "010001",
    },
    {
      name: "enum integer variant",
      schema: { enum: [{ struct: { success: "bool" } }, { struct: { amount: "u16" } }] },
      output: { amount: 256n },
      expected: "010001",
    },
    {
      name: "enum Boolean variant",
      schema: { enum: [{ struct: { success: "bool" } }, { struct: { amount: "u16" } }] },
      output: { success: true },
      expected: "0001",
    },
  ];
  it.each(nativeCases)("converts $name", ({ schema, output, expected }) => {
    expect(hex(serializeRespondOutput(schema, output))).toBe(expected);
  });
  const narrowingSchemas: { name: string; schema: RespondSchemaInput }[] = [
    { name: "option", schema: { struct: { amount: { option: "u16" } } } },
    { name: "enum", schema: { enum: [{ struct: { amount: "u16" } }] } },
  ];
  it.each(narrowingSchemas)("rejects overflow within $name", ({ schema }) => {
    expect(() => serializeRespondOutput(schema, { amount: 65536n })).toThrow(
      "does not fit Borsh u16",
    );
  });
});

const BOOL_RESPONSE_SCHEMA = { struct: { success: "bool" } };
const BOOL_ABI_SCHEMA = [{ name: "success", type: "bool" }];
const NOT_TRACED: EvmTraceOutput = { kind: EvmTraceOutputKind.NotTraced };
const NO_RETURN_DATA: EvmTraceOutput = { kind: EvmTraceOutputKind.NoReturnData };
const PLAIN_TRANSFER_SCHEMAS: RespondPathSchemas = {
  outputDeserializationSchema: BOOL_ABI_SCHEMA,
  respondSerializationSchema: BOOL_RESPONSE_SCHEMA,
};
const VOID_CALL_SCHEMAS: RespondPathSchemas = {
  outputDeserializationSchema: [],
  respondSerializationSchema: BOOL_RESPONSE_SCHEMA,
};

describe("executed EVM Borsh response pipeline", () => {
  const successCases: {
    name: string;
    schemas: RespondPathSchemas;
    call: boolean;
    trace: EvmTraceOutput;
    expected: string;
  }[] = [
    {
      name: "transfer",
      schemas: PLAIN_TRANSFER_SCHEMAS,
      call: false,
      trace: NOT_TRACED,
      expected: "01",
    },
    {
      name: "transfer ignores malformed ABI schema",
      schemas: { ...PLAIN_TRANSFER_SCHEMAS, outputDeserializationSchema: "bad" },
      call: false,
      trace: NOT_TRACED,
      expected: "01",
    },
    { name: "void", schemas: VOID_CALL_SCHEMAS, call: true, trace: NO_RETURN_DATA, expected: "01" },
    {
      name: "empty struct default",
      schemas: { ...VOID_CALL_SCHEMAS, respondSerializationSchema: { struct: {} } },
      call: false,
      trace: NOT_TRACED,
      expected: "",
    },
    {
      name: "empty return",
      schemas: VOID_CALL_SCHEMAS,
      call: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: "0x" },
      expected: "01",
    },
    {
      name: "false result",
      schemas: PLAIN_TRANSFER_SCHEMAS,
      call: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: coder.encode(["bool"], [false]) },
      expected: "00",
    },
    {
      name: "narrowed amount",
      schemas: {
        outputDeserializationSchema: ABI_SCHEMA,
        respondSerializationSchema: RESPONSE_SCHEMA,
      },
      call: true,
      trace: {
        kind: EvmTraceOutputKind.Output,
        returnData: coder.encode(["bool", "uint256"], [true, 42n]),
      },
      expected: "012a" + "00".repeat(15),
    },
    {
      name: "native string default",
      schemas: {
        ...VOID_CALL_SCHEMAS,
        respondSerializationSchema: { struct: { message: "string" } },
      },
      call: true,
      trace: NO_RETURN_DATA,
      expected: "19000000" + "6e6f6e5f66756e6374696f6e5f63616c6c5f73756363657373",
    },
  ];
  it.each(successCases)("$name", ({ schemas, call, trace, expected }) => {
    expect(hex(executedEvmRespondOutput(schemas, call, trace))).toBe(expected);
  });
  it.each([
    {
      name: "untraced",
      schemas: PLAIN_TRANSFER_SCHEMAS,
      trace: NOT_TRACED,
      error: /needs its trace/,
    },
    {
      name: "missing return",
      schemas: PLAIN_TRANSFER_SCHEMAS,
      trace: NO_RETURN_DATA,
      error: /no return data/,
    },
    {
      name: "unexpected return",
      schemas: VOID_CALL_SCHEMAS,
      trace: { kind: EvmTraceOutputKind.Output, returnData: "0x01" },
      error: /declares no return values/,
    },
    {
      name: "invalid ABI",
      schemas: { ...PLAIN_TRANSFER_SCHEMAS, outputDeserializationSchema: "bad" },
      trace: { kind: EvmTraceOutputKind.Output, returnData: "0x01" },
      error: /not valid JSON/,
    },
    {
      name: "no default",
      schemas: { ...VOID_CALL_SCHEMAS, respondSerializationSchema: RESPONSE_SCHEMA },
      trace: NO_RETURN_DATA,
      error: /no non-function-call default/,
    },
    {
      name: "overflow before attestation",
      schemas: {
        outputDeserializationSchema: ABI_SCHEMA,
        respondSerializationSchema: RESPONSE_SCHEMA,
      },
      trace: {
        kind: EvmTraceOutputKind.Output,
        returnData: coder.encode(["bool", "uint256"], [true, 1n << 128n]),
      },
      error: /does not fit Borsh u128/,
    },
  ])("rejects $name", ({ schemas, trace, error }) => {
    expect(() => executedEvmRespondOutput(schemas, true, trace)).toThrow(error);
  });
});
