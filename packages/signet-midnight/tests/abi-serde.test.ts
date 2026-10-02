import { ethers } from "ethers";
import { describe, expect, it } from "vitest";

import {
  type AbiDecodedOutput,
  canonicalSchemaText,
  deriveRespondSchema,
  deserializeEvmOutput,
  type EvmSchemaField,
  type EvmSchemaInput,
  type EvmTraceOutput,
  evmTraceOutputFromCallFrame,
  EvmTraceOutputKind,
  executedEvmRespondOutput,
  isEvmContractCall,
  type JsonValue,
  respondOutputWidth,
  serializeRespondOutput,
  unsupportedEvmOutputFields,
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
    { name: "empty text", input: "" },
    { name: "no bytes", input: new Uint8Array(0) },
    { name: "an unset all-NUL on-chain field", input: new Uint8Array(34) },
  ];

  it.each(forms)("$name", ({ input }) => {
    expect(deserializeEvmOutput(input, "0x")).toEqual({});
  });
});

describe("schema text and bytes must be canonical", () => {
  const fields: EvmSchemaField[] = [
    { name: "ok", type: "bool" },
    { name: "amount", type: "uint256" },
  ];
  const canonical = '[{"name":"ok","type":"bool"},{"name":"amount","type":"uint256"}]';

  it("canonicalSchemaText is JSON.stringify of {name, type} in order", () => {
    expect(canonicalSchemaText(fields)).toBe(canonical);
    expect(canonicalSchemaText([])).toBe("[]");
    expect(canonicalSchemaText([{ name: "ok", type: "bool", extra: 1 } as EvmSchemaField])).toBe(
      '[{"name":"ok","type":"bool"}]',
    );
  });

  it.each([
    { name: "the canonical text", input: canonical },
    { name: "the canonical bytes", input: new TextEncoder().encode(canonical) },
    { name: "the canonical bytes NUL-padded", input: nulPadded(fields, 100) },
  ])("accepts $name", ({ input }) => {
    expect(deserializeEvmOutput(input, coder.encode(["bool", "uint256"], [true, 1n]))).toEqual({
      ok: true,
      amount: 1n,
    });
  });

  const rejected: { name: string; input: string | Uint8Array; error: RegExp }[] = [
    { name: "blank text", input: "  ", error: /not valid JSON/ },
    {
      name: "whitespace inside",
      input: '[ {"name": "ok", "type": "bool"} ]',
      error: /not canonical/,
    },
    {
      name: "a trailing newline",
      input: '[{"name":"ok","type":"bool"}]\n',
      error: /not canonical/,
    },
    { name: "type before name", input: '[{"type":"bool","name":"ok"}]', error: /not canonical/ },
    {
      name: "an extra key",
      input: '[{"name":"ok","type":"bool","maxBytes":1}]',
      error: /not canonical/,
    },
    {
      name: "a duplicate JSON key",
      input: '[{"name":"x","name":"ok","type":"bool"}]',
      error: /not canonical/,
    },
    {
      name: "a unicode escape",
      input: '[{"name":"\\u006fk","type":"bool"}]',
      error: /not canonical/,
    },
    {
      name: "bytes after the first NUL",
      input: new Uint8Array([...new TextEncoder().encode("[]"), 0, 0x78]),
      error: /from the first NUL on must be NUL/,
    },
    {
      name: "invalid UTF-8",
      input: new Uint8Array([0x5b, 0xff, 0x5d]),
      error: /not valid JSON/,
    },
  ];

  it.each(rejected)("rejects $name", ({ input, error }) => {
    expect(() => deserializeEvmOutput(input, "0x")).toThrow(error);
  });

  it("names the canonical text in the rejection", () => {
    expect(() => deserializeEvmOutput('[ {"name":"ok","type":"bool"} ]', "0x")).toThrow(
      'expected exactly [{"name":"ok","type":"bool"}]',
    );
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
    ...["banana", "field", "bytes0", "bytes33", "uint256 ", "bool "].map((type) => ({
      name: `type '${type}' is not an ABI type (ethers.ParamType is the grammar authority)`,
      schema: [{ name: "x", type }],
      error: /has an invalid ABI type/,
    })),
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
    ...["1", "0x1", "a b", "a-b", " a", "a ", "a.b", "é"].map((name) => ({
      name: `field name '${name}' is not a Solidity identifier`,
      schema: [{ name, type: "bool" }],
      error: /is not a Solidity identifier/,
    })),
    {
      name: "field named __proto__ (a valid identifier no object can carry)",
      schema: [{ name: "__proto__", type: "bool" }],
      error: /'__proto__' is refused/,
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

describe("deserializeEvmOutput: field names are own properties of the output", () => {
  // Every Solidity identifier is accepted, including names that exist on
  // Object.prototype, and each lands as the output's own property.
  it.each(["_x", "$y", "ok1", "__proto", "constructor", "hasOwnProperty", "toString"])(
    "'%s'",
    (name) => {
      const output = deserializeEvmOutput([{ name, type: "bool" }], coder.encode(["bool"], [true]));
      expect(Object.hasOwn(output, name)).toBe(true);
      expect(output[name]).toBe(true);
    },
  );
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

const BOOL_ABI_SCHEMA: EvmSchemaField[] = [{ name: "success", type: "bool" }];
const BOOL_UINT_ABI_SCHEMA: EvmSchemaField[] = [
  { name: "success", type: "bool" },
  { name: "amount", type: "uint256" },
];

/** The 32 little-endian bytes of `value`: the Borsh integer byte order, the ABI word reversed. */
const word = (value: bigint): number[] =>
  Array.from(ethers.getBytes(ethers.toBeHex(value, 32))).reverse();

// ===========================================================================
// deriveRespondSchema / respondOutputWidth / unsupportedEvmOutputFields
// ===========================================================================

describe("deriveRespondSchema: the Borsh struct an output schema derives", () => {
  const cases: {
    name: string;
    schema: EvmSchemaField[];
    derived: ReturnType<typeof deriveRespondSchema>;
    width: number;
  }[] = [
    { name: "bool", schema: BOOL_ABI_SCHEMA, derived: { struct: { success: "bool" } }, width: 1 },
    {
      name: "bool + uint256",
      schema: BOOL_UINT_ABI_SCHEMA,
      derived: { struct: { success: "bool", amount: { array: { type: "u8", len: 32 } } } },
      width: 33,
    },
    {
      name: "bytes4 + bytes32",
      schema: [
        { name: "selector", type: "bytes4" },
        { name: "hash", type: "bytes32" },
      ],
      derived: {
        struct: {
          selector: { array: { type: "u8", len: 4 } },
          hash: { array: { type: "u8", len: 32 } },
        },
      },
      width: 36,
    },
    {
      name: "address",
      schema: [{ name: "to", type: "address" }],
      derived: { struct: { to: { array: { type: "u8", len: 20 } } } },
      width: 20,
    },
    { name: "empty", schema: [], derived: { struct: {} }, width: 0 },
  ];

  it.each(cases)("$name", ({ schema, derived, width }) => {
    expect(deriveRespondSchema(schema)).toEqual(derived);
    expect(respondOutputWidth(schema)).toBe(width);
    expect(unsupportedEvmOutputFields(schema)).toEqual([]);
  });

  it.each([
    { name: "JSON text", input: JSON.stringify(BOOL_UINT_ABI_SCHEMA) },
    { name: "NUL-padded on-chain bytes", input: nulPadded(BOOL_UINT_ABI_SCHEMA, 128) },
  ])("derives the same struct from the $name form", ({ input }) => {
    expect(deriveRespondSchema(input)).toEqual(deriveRespondSchema(BOOL_UINT_ABI_SCHEMA));
  });

  it("keeps the schema's field order", () => {
    const reversed = [...BOOL_UINT_ABI_SCHEMA].reverse();
    expect(Object.keys((deriveRespondSchema(reversed) as { struct: object }).struct)).toEqual([
      "amount",
      "success",
    ]);
  });

  it("serialises members in schema order whatever the names", () => {
    // Names an object would not reorder: identifiers, however digit-heavy.
    const schema: EvmSchemaField[] = [
      { name: "z9", type: "bool" },
      { name: "_1", type: "bytes1" },
      { name: "a", type: "bool" },
    ];
    expect(Object.keys((deriveRespondSchema(schema) as { struct: object }).struct)).toEqual([
      "z9",
      "_1",
      "a",
    ]);
    expect(hex(serializeRespondOutput(schema, { z9: true, _1: "0xab", a: false }))).toBe("01ab00");
  });
});

describe("unsupportedEvmOutputFields: the MPC's drop decision", () => {
  it.each([
    "int256",
    "uint8",
    "uint128",
    "string",
    "bytes",
    "uint256[]",
    "bool[2]",
    "(uint256,bool)",
    "tuple(uint256,bool)",
    // Valid ABI spellings ethers normalises to a supported type, refused
    // because the match is on the raw string, as the MPC's is.
    "uint",
    " uint256",
    "address payable",
  ])("names a %s field without throwing, and derivation refuses it", (type) => {
    const schema: EvmSchemaField[] = [
      { name: "ok", type: "bool" },
      { name: "x", type },
    ];
    expect(unsupportedEvmOutputFields(schema)).toEqual([{ name: "x", type }]);
    expect(() => deriveRespondSchema(schema)).toThrow(/unsupported ABI output type 'x' \(/);
    expect(() => respondOutputWidth(schema)).toThrow(/unsupported ABI output type/);
    expect(() => serializeRespondOutput(schema, { ok: true, x: 0n })).toThrow(
      /unsupported ABI output type/,
    );
  });

  it("lists every unsupported field in schema order", () => {
    expect(
      unsupportedEvmOutputFields([
        { name: "a", type: "int256" },
        { name: "ok", type: "bool" },
        { name: "s", type: "string" },
      ]),
    ).toEqual([
      { name: "a", type: "int256" },
      { name: "s", type: "string" },
    ]);
  });

  it("still refuses a malformed schema shape", () => {
    expect(() => unsupportedEvmOutputFields("not json at all")).toThrow(/JSON/);
    expect(() => unsupportedEvmOutputFields('{"name":"x","type":"bool"}')).toThrow(/JSON array/);
    expect(() => unsupportedEvmOutputFields([{ name: "x", type: "bytes33" }])).toThrow(
      /invalid ABI type/,
    );
  });

  it("drops 'uint' although ethers decodes it as uint256", () => {
    const schema: EvmSchemaField[] = [{ name: "x", type: "uint" }];
    expect(deserializeEvmOutput(schema, coder.encode(["uint256"], [7n]))).toEqual({ x: 7n });
    expect(unsupportedEvmOutputFields(schema)).toEqual(schema);
  });
});

// ===========================================================================
// serializeRespondOutput
// ===========================================================================

describe("serializeRespondOutput: ABI values to the attested bytes", () => {
  it.each([0n, 42n, (1n << 128n) - 1n, 1n << 128n, (1n << 256n) - 1n])(
    "carries uint256 %s whole as 32 little-endian bytes after a bool",
    (amount) => {
      const output = deserializeEvmOutput(
        BOOL_UINT_ABI_SCHEMA,
        coder.encode(["bool", "uint256"], [true, amount]),
      );
      const bytes = serializeRespondOutput(BOOL_UINT_ABI_SCHEMA, output);
      expect(bytes).toHaveLength(33);
      expect(bytes).toEqual(Uint8Array.from([1, ...word(amount)]));
    },
  );

  it.each([
    { name: "typed array", schema: BOOL_UINT_ABI_SCHEMA },
    { name: "JSON text", schema: JSON.stringify(BOOL_UINT_ABI_SCHEMA) },
    { name: "NUL-padded on-chain bytes", schema: nulPadded(BOOL_UINT_ABI_SCHEMA, 128) },
  ])("accepts the schema as $name", ({ schema }) => {
    expect(serializeRespondOutput(schema, { success: true, amount: 42n })).toEqual(
      Uint8Array.from([1, ...word(42n)]),
    );
  });

  it.each([
    { name: "a bigint", amount: 42n },
    { name: "a number", amount: 42 },
    { name: "a decimal string", amount: "42" },
  ])("accepts a uint256 as $name", ({ amount }) => {
    expect(serializeRespondOutput(BOOL_UINT_ABI_SCHEMA, { success: true, amount })).toEqual(
      Uint8Array.from([1, ...word(42n)]),
    );
  });

  it.each([
    { name: "negative", amount: -1n },
    { name: "2^256", amount: 1n << 256n },
    { name: "a fraction", amount: 1.5 },
    { name: "an unsafe number", amount: Number.MAX_SAFE_INTEGER + 1 },
    { name: "a hex string", amount: "0x2a" },
    { name: "an empty string", amount: "" },
  ])("rejects a uint256 value that is $name", ({ amount }) => {
    expect(() => serializeRespondOutput(BOOL_UINT_ABI_SCHEMA, { success: true, amount })).toThrow(
      RangeError,
    );
  });

  it("rejects a non-integer kind for uint256 and a non-boolean for bool", () => {
    expect(() =>
      serializeRespondOutput(BOOL_UINT_ABI_SCHEMA, { success: true, amount: true }),
    ).toThrow(TypeError);
    expect(() => serializeRespondOutput(BOOL_ABI_SCHEMA, { success: 1n })).toThrow(TypeError);
  });

  it.each([
    { name: "a hex string", value: "0x" + "ab".repeat(32) },
    { name: "bytes", value: new Uint8Array(32).fill(0xab) },
  ])("carries bytes32 given as $name", ({ value }) => {
    expect(serializeRespondOutput([{ name: "hash", type: "bytes32" }], { hash: value })).toEqual(
      new Uint8Array(32).fill(0xab),
    );
  });

  it.each([
    { name: "the checksummed hex string ethers decodes", value: ethers.getAddress(ADDRESS) },
    { name: "lowercase hex", value: ADDRESS },
    { name: "bytes", value: ethers.getBytes(ADDRESS) },
  ])("carries an address given as $name, in wire byte order", ({ value }) => {
    expect(serializeRespondOutput([{ name: "to", type: "address" }], { to: value })).toEqual(
      ethers.getBytes(ADDRESS),
    );
  });

  it("carries an address decoded from return data byte for byte", () => {
    const output = deserializeEvmOutput(
      [{ name: "to", type: "address" }],
      coder.encode(["address"], [ADDRESS]),
    );
    expect(serializeRespondOutput([{ name: "to", type: "address" }], output)).toEqual(
      ethers.getBytes(ADDRESS),
    );
  });

  it("rejects an address of the wrong length", () => {
    expect(() =>
      serializeRespondOutput([{ name: "to", type: "address" }], { to: "0xabcd" }),
    ).toThrow();
  });

  it("rejects bytesN of the wrong length", () => {
    expect(() =>
      serializeRespondOutput([{ name: "hash", type: "bytes32" }], { hash: "0xabcd" }),
    ).toThrow();
  });

  it("rejects a missing field", () => {
    expect(() => serializeRespondOutput(BOOL_UINT_ABI_SCHEMA, { success: true })).toThrow(
      /missing value for 'amount'/,
    );
  });

  it("serialises an empty schema to no bytes", () => {
    expect(serializeRespondOutput([], {})).toEqual(new Uint8Array(0));
  });
});

// ===========================================================================
// executedEvmRespondOutput
// ===========================================================================

const NOT_TRACED: EvmTraceOutput = { kind: EvmTraceOutputKind.NotTraced };
const NO_RETURN_DATA: EvmTraceOutput = { kind: EvmTraceOutputKind.NoReturnData };
const EMPTY_RETURN: EvmTraceOutput = { kind: EvmTraceOutputKind.Output, returnData: "0x" };

describe("executedEvmRespondOutput: the attested output of an executed transaction", () => {
  it.each([
    {
      name: "a plain transfer under an empty schema attests an empty output",
      schema: [],
      call: false,
      trace: NOT_TRACED,
      expected: "",
    },
    {
      name: "a call without return data under an empty schema attests an empty output",
      schema: [],
      call: true,
      trace: NO_RETURN_DATA,
      expected: "",
    },
    {
      name: "a call with empty return data under an empty schema attests an empty output",
      schema: [],
      call: true,
      trace: EMPTY_RETURN,
      expected: "",
    },
    {
      name: "a bool result",
      schema: BOOL_ABI_SCHEMA,
      call: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: coder.encode(["bool"], [false]) },
      expected: "00",
    },
    {
      name: "a bool and a uint256 result",
      schema: BOOL_UINT_ABI_SCHEMA,
      call: true,
      trace: {
        kind: EvmTraceOutputKind.Output,
        returnData: coder.encode(["bool", "uint256"], [true, 42n]),
      },
      expected: "01" + "2a" + "00".repeat(31),
    },
    {
      name: "an address result, the 20 wire bytes",
      schema: [{ name: "to", type: "address" }],
      call: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: coder.encode(["address"], [ADDRESS]) },
      expected: ADDRESS.slice(2),
    },
    {
      name: "a uint256 at the type's maximum, carried whole",
      schema: BOOL_UINT_ABI_SCHEMA,
      call: true,
      trace: {
        kind: EvmTraceOutputKind.Output,
        returnData: coder.encode(["bool", "uint256"], [true, (1n << 256n) - 1n]),
      },
      expected: "01" + "ff".repeat(32),
    },
    {
      name: "a bytes4 result, zero-padded as the ABI requires",
      schema: [{ name: "tag", type: "bytes4" }],
      call: true,
      trace: {
        kind: EvmTraceOutputKind.Output,
        returnData: coder.encode(["bytes4"], ["0xdeadbeef"]),
      },
      expected: "deadbeef",
    },
    {
      name: "return data with words past the declared fields",
      schema: BOOL_ABI_SCHEMA,
      call: true,
      trace: {
        kind: EvmTraceOutputKind.Output,
        returnData: coder.encode(["bool", "uint256"], [true, 7n]),
      },
      expected: "01",
    },
  ])("$name", ({ schema, call, trace, expected }) => {
    expect(hex(executedEvmRespondOutput(schema, call, trace))).toBe(expected);
  });

  // The schema and the return data must agree, and the schema's types are
  // checked on every path, so nothing the MPC should have dropped attests.
  it.each([
    {
      name: "a plain transfer under a non-empty schema",
      schema: BOOL_ABI_SCHEMA,
      call: false,
      trace: NOT_TRACED,
      error: /plain transfer returns nothing, but the output schema declares return values/,
    },
    {
      name: "a plain transfer under a malformed schema",
      schema: "bad",
      call: false,
      trace: NOT_TRACED,
      error: /not valid JSON/,
    },
    {
      name: "a plain transfer under an unsupported output type",
      schema: [{ name: "note", type: "string" }],
      call: false,
      trace: NOT_TRACED,
      error: /unsupported ABI output type 'note' \(string\)/,
    },
    {
      name: "a contract call that was not traced",
      schema: BOOL_ABI_SCHEMA,
      call: true,
      trace: NOT_TRACED,
      error: /needs its trace/,
    },
    {
      name: "a contract call that was not traced, even under an empty schema",
      schema: [],
      call: true,
      trace: NOT_TRACED,
      error: /needs its trace/,
    },
    {
      name: "no return data under a non-empty schema",
      schema: BOOL_ABI_SCHEMA,
      call: true,
      trace: NO_RETURN_DATA,
      error: /returned no data, but the output schema declares return values/,
    },
    {
      name: "empty return data under a non-empty schema",
      schema: BOOL_ABI_SCHEMA,
      call: true,
      trace: EMPTY_RETURN,
      error: /returned no data, but the output schema declares return values/,
    },
    {
      name: "return data under an empty schema",
      schema: [],
      call: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: coder.encode(["bool"], [true]) },
      error: /returned data, but the output schema declares no return values/,
    },
    {
      name: "return data a non-empty schema cannot decode",
      schema: BOOL_UINT_ABI_SCHEMA,
      call: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: "0x01" },
      error: /./,
    },
    {
      name: "a malformed schema on a call without return data",
      schema: "bad",
      call: true,
      trace: NO_RETURN_DATA,
      error: /not valid JSON/,
    },
    {
      name: "an unsupported output type on a call without return data",
      schema: [{ name: "note", type: "string" }],
      call: true,
      trace: NO_RETURN_DATA,
      error: /unsupported ABI output type 'note' \(string\)/,
    },
    {
      name: "an unsupported output type on a call that returned data",
      schema: [{ name: "note", type: "string" }],
      call: true,
      trace: {
        kind: EvmTraceOutputKind.Output,
        returnData: coder.encode(["string"], ["hello"]),
      },
      error: /unsupported ABI output type 'note' \(string\)/,
    },
    // Return data must be canonical ABI: the ABI library would decode every
    // row below, so the refusal is this module's.
    {
      name: "a bool word of 2",
      schema: BOOL_ABI_SCHEMA,
      call: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: "0x" + "00".repeat(31) + "02" },
      error: /'success' \(bool\) word 0x0{62}02 is not canonical ABI/,
    },
    {
      name: "a bool word with a dirty high byte",
      schema: BOOL_ABI_SCHEMA,
      call: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: "0x01" + "00".repeat(30) + "01" },
      error: /'success' \(bool\) word .* is not canonical ABI/,
    },
    {
      name: "an address word with dirty high bytes",
      schema: [{ name: "to", type: "address" }],
      call: true,
      trace: {
        kind: EvmTraceOutputKind.Output,
        returnData: "0x" + "ff".repeat(12) + ADDRESS.slice(2),
      },
      error: /'to' \(address\) word .* is not canonical ABI/,
    },
    {
      name: "a bytes4 word with dirty padding",
      schema: [{ name: "tag", type: "bytes4" }],
      call: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: "0xdeadbeef" + "ff".repeat(28) },
      error: /'tag' \(bytes4\) word .* is not canonical ABI/,
    },
    {
      name: "return data that is not whole words",
      schema: BOOL_ABI_SCHEMA,
      call: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: coder.encode(["bool"], [true]) + "00" },
      error: /return data of 33 bytes is not whole ABI words/,
    },
    {
      name: "fewer words than declared fields",
      schema: BOOL_UINT_ABI_SCHEMA,
      call: true,
      trace: { kind: EvmTraceOutputKind.Output, returnData: coder.encode(["bool"], [true]) },
      error: /holds 1 word but the output schema declares 2 fields/,
    },
  ])("refuses $name", ({ schema, call, trace, error }) => {
    expect(() => executedEvmRespondOutput(schema, call, trace)).toThrow(error);
  });
});

// ===========================================================================
// checkCanonicalReturnData, through executedEvmRespondOutput's decode path
// ===========================================================================

/** A 32-byte ABI word from its hex digits, left-padded with zeros. */
const abiWord = (hexDigits: string): string => hexDigits.padStart(64, "0");
/** Return data from words, as the trace output a contract call yields. */
const returned = (...words: string[]): EvmTraceOutput => ({
  kind: EvmTraceOutputKind.Output,
  returnData: "0x" + words.join(""),
});
/** A word of `byte` repeated 32 times. */
const filled = (byte: number): string => byte.toString(16).padStart(2, "0").repeat(32);
/** A zero word with one byte set, by position 0..31. */
const wordWithByte = (position: number, byte: number): string => {
  const bytes = new Array<string>(32).fill("00");
  bytes[position] = byte.toString(16).padStart(2, "0");
  return bytes.join("");
};

describe("checkCanonicalReturnData: bool words", () => {
  it.each([0, 1])("accepts a last byte of %i", (last) => {
    expect(
      hex(executedEvmRespondOutput(BOOL_ABI_SCHEMA, true, returned(wordWithByte(31, last)))),
    ).toBe(last.toString(16).padStart(2, "0"));
  });

  it.each(Array.from({ length: 254 }, (_, i) => i + 2))("refuses a last byte of %i", (last) => {
    expect(() =>
      executedEvmRespondOutput(BOOL_ABI_SCHEMA, true, returned(wordWithByte(31, last))),
    ).toThrow(/'success' \(bool\) word .* is not canonical ABI/);
  });

  it.each(Array.from({ length: 31 }, (_, i) => i))(
    "refuses a set byte at position %i above a last byte of 1",
    (position) => {
      const word = wordWithByte(position, 0x01).slice(0, 62) + "01";
      expect(() => executedEvmRespondOutput(BOOL_ABI_SCHEMA, true, returned(word))).toThrow(
        /'success' \(bool\) word .* is not canonical ABI/,
      );
    },
  );
});

describe("checkCanonicalReturnData: address words", () => {
  const schema: EvmSchemaField[] = [{ name: "to", type: "address" }];

  it("accepts any 20 low bytes", () => {
    expect(hex(executedEvmRespondOutput(schema, true, returned(abiWord("ff".repeat(20)))))).toBe(
      "ff".repeat(20),
    );
  });

  it.each(Array.from({ length: 12 }, (_, i) => i))(
    "refuses a set high byte at position %i",
    (position) => {
      const word = wordWithByte(position, 0x01).slice(0, 24) + "11".repeat(20);
      expect(() => executedEvmRespondOutput(schema, true, returned(word))).toThrow(
        /'to' \(address\) word .* is not canonical ABI/,
      );
    },
  );
});

describe("checkCanonicalReturnData: bytesN words", () => {
  const sizes = Array.from({ length: 32 }, (_, i) => i + 1);

  it.each(sizes)("accepts bytes%i filled to exactly N bytes", (n) => {
    const schema: EvmSchemaField[] = [{ name: "b", type: `bytes${String(n)}` }];
    const word = "ff".repeat(n) + "00".repeat(32 - n);
    expect(hex(executedEvmRespondOutput(schema, true, returned(word)))).toBe("ff".repeat(n));
  });

  it.each(sizes.filter((n) => n < 32))("refuses bytes%i with its first padding byte set", (n) => {
    const schema: EvmSchemaField[] = [{ name: "b", type: `bytes${String(n)}` }];
    const word = "ff".repeat(n) + "01" + "00".repeat(31 - n);
    expect(() => executedEvmRespondOutput(schema, true, returned(word))).toThrow(
      new RegExp(`'b' \\(bytes${String(n)}\\) word .* is not canonical ABI`),
    );
  });

  it.each(sizes.filter((n) => n < 32))("refuses bytes%i with its last padding byte set", (n) => {
    const schema: EvmSchemaField[] = [{ name: "b", type: `bytes${String(n)}` }];
    const word = "ff".repeat(n) + "00".repeat(31 - n) + "01";
    expect(() => executedEvmRespondOutput(schema, true, returned(word))).toThrow(
      /is not canonical ABI/,
    );
  });

  it("bytes32 has no padding, so every word is canonical", () => {
    const schema: EvmSchemaField[] = [{ name: "b", type: "bytes32" }];
    expect(hex(executedEvmRespondOutput(schema, true, returned(filled(0xff))))).toBe(filled(0xff));
  });
});

describe("checkCanonicalReturnData: uint256 words and data shape", () => {
  const uint: EvmSchemaField[] = [{ name: "n", type: "uint256" }];

  it("accepts every uint256 word", () => {
    for (const byte of [0x00, 0x01, 0x7f, 0x80, 0xff]) {
      expect(executedEvmRespondOutput(uint, true, returned(filled(byte)))).toHaveLength(32);
    }
  });

  it.each(Array.from({ length: 31 }, (_, i) => i + 1))(
    "refuses return data of %i bytes as not whole words",
    (length) => {
      expect(() =>
        executedEvmRespondOutput(uint, true, {
          kind: EvmTraceOutputKind.Output,
          returnData: new Uint8Array(length),
        }),
      ).toThrow(new RegExp(`return data of ${String(length)} bytes is not whole ABI words`));
    },
  );

  it.each([33, 63, 65, 95])("refuses return data of %i bytes", (length) => {
    expect(() =>
      executedEvmRespondOutput(uint, true, {
        kind: EvmTraceOutputKind.Output,
        returnData: new Uint8Array(length),
      }),
    ).toThrow(/is not whole ABI words/);
  });

  it.each([
    { fields: 2, words: 1 },
    { fields: 3, words: 2 },
    { fields: 4, words: 1 },
  ])("refuses $words word(s) for $fields fields", ({ fields, words }) => {
    const schema: EvmSchemaField[] = Array.from({ length: fields }, (_, i) => ({
      name: `f${String(i)}`,
      type: "uint256",
    }));
    expect(() =>
      executedEvmRespondOutput(schema, true, returned(...Array<string>(words).fill(abiWord("1")))),
    ).toThrow(
      new RegExp(
        `holds ${String(words)} word${words === 1 ? "" : "s"} but the output schema declares ${String(fields)} fields`,
      ),
    );
  });

  it("ignores trailing words, whatever they hold", () => {
    expect(
      hex(
        executedEvmRespondOutput(
          BOOL_ABI_SCHEMA,
          true,
          returned(abiWord("1"), filled(0xff), wordWithByte(0, 0x80), filled(0x02)),
        ),
      ),
    ).toBe("01");
  });

  it("blames the field whose word is dirty, by position", () => {
    const schema: EvmSchemaField[] = [
      { name: "ok", type: "bool" },
      { name: "to", type: "address" },
      { name: "tag", type: "bytes4" },
      { name: "n", type: "uint256" },
    ];
    const clean = [
      abiWord("1"),
      abiWord("11".repeat(20)),
      "deadbeef" + "00".repeat(28),
      filled(0xff),
    ];
    expect(hex(executedEvmRespondOutput(schema, true, returned(...clean)))).toBe(
      "01" + "11".repeat(20) + "deadbeef" + "ff".repeat(32),
    );
    const dirtyAt = (index: number, word: string): string[] =>
      clean.map((w, i) => (i === index ? word : w));
    expect(() =>
      executedEvmRespondOutput(schema, true, returned(...dirtyAt(0, abiWord("2")))),
    ).toThrow(/'ok' \(bool\)/);
    expect(() =>
      executedEvmRespondOutput(schema, true, returned(...dirtyAt(1, filled(0x11)))),
    ).toThrow(/'to' \(address\)/);
    expect(() =>
      executedEvmRespondOutput(schema, true, returned(...dirtyAt(2, "deadbeef" + "ff".repeat(28)))),
    ).toThrow(/'tag' \(bytes4\)/);
  });
});

describe("checkCanonicalReturnData: the ABI library alone would accept what it refuses", () => {
  // The reason the check exists: ethers decodes each of these without error.
  // (An address word with dirty high bytes is the one case ethers refuses itself.)
  it.each([
    { name: "a bool word of 2", schema: BOOL_ABI_SCHEMA, data: wordWithByte(31, 2) },
    {
      name: "bytes4 with dirty padding",
      schema: [{ name: "tag", type: "bytes4" }],
      data: "deadbeef" + "ff".repeat(28),
    },
    { name: "33 bytes", schema: BOOL_ABI_SCHEMA, data: abiWord("1") + "00" },
  ])("$name", ({ schema, data }) => {
    expect(() => deserializeEvmOutput(schema, "0x" + data)).not.toThrow();
    expect(() => executedEvmRespondOutput(schema, true, returned(data))).toThrow(
      /is not canonical ABI|is not whole ABI words/,
    );
  });
});

describe("checkCanonicalReturnData: seeded mutation sweep over canonical encodings", () => {
  // xorshift32: deterministic, so a failure reproduces from the seed.
  let state = 0x9e3779b9;
  const random = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  const randomInt = (max: number): number => Math.floor(random() * max);
  const randomHex = (bytes: number): string =>
    Array.from({ length: bytes }, () => randomInt(256).toString(16).padStart(2, "0")).join("");

  /** A random schema field with a canonical word for it and the word's padding byte positions. */
  const randomField = (
    index: number,
  ): { field: EvmSchemaField; word: string; padding: number[]; valueBytes: number[] } => {
    const name = `f${String(index)}`;
    const all = Array.from({ length: 32 }, (_, i) => i);
    switch (randomInt(4)) {
      case 0:
        return {
          field: { name, type: "bool" },
          word: wordWithByte(31, randomInt(2)),
          padding: all.slice(0, 31),
          valueBytes: [],
        };
      case 1:
        return {
          field: { name, type: "uint256" },
          word: randomHex(32),
          padding: [],
          valueBytes: all,
        };
      case 2:
        return {
          field: { name, type: "address" },
          word: "00".repeat(12) + randomHex(20),
          padding: all.slice(0, 12),
          valueBytes: all.slice(12),
        };
      default: {
        const n = randomInt(32) + 1;
        return {
          field: { name, type: `bytes${String(n)}` },
          word: randomHex(n) + "00".repeat(32 - n),
          padding: all.slice(n),
          valueBytes: all.slice(0, n),
        };
      }
    }
  };

  const setByte = (words: string[], wordIndex: number, byte: number, value: number): string[] =>
    words.map((w, i) =>
      i === wordIndex
        ? w.slice(0, byte * 2) + value.toString(16).padStart(2, "0") + w.slice(byte * 2 + 2)
        : w,
    );

  it("accepts every canonical encoding, refuses every padding mutation, keeps every value mutation", () => {
    let paddingMutations = 0;
    let valueMutations = 0;
    for (let round = 0; round < 60; round += 1) {
      const fields = Array.from({ length: randomInt(4) + 1 }, (_, i) => randomField(i));
      const schema = fields.map(({ field }) => field);
      const words = fields.map(({ word }) => word);
      expect(executedEvmRespondOutput(schema, true, returned(...words))).toHaveLength(
        respondOutputWidth(schema),
      );
      fields.forEach(({ field, padding, valueBytes }, wordIndex) => {
        for (const byte of padding) {
          const mutated = setByte(words, wordIndex, byte, randomInt(255) + 1);
          // A plain substring match: the type string is data, never a pattern.
          expect(() => executedEvmRespondOutput(schema, true, returned(...mutated))).toThrow(
            `'${field.name}' (${field.type}) word`,
          );
          paddingMutations += 1;
        }
        for (const byte of valueBytes) {
          const mutated = setByte(words, wordIndex, byte, randomInt(256));
          expect(executedEvmRespondOutput(schema, true, returned(...mutated))).toHaveLength(
            respondOutputWidth(schema),
          );
          valueMutations += 1;
        }
      });
    }
    // The sweep must have exercised both branches, or it proves nothing.
    expect(paddingMutations).toBeGreaterThan(500);
    expect(valueMutations).toBeGreaterThan(500);
  });
});
