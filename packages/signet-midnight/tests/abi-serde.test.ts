// Table-driven tests for the two headline abi-serde functions.
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

import { describe, expect, it } from "vitest";
import { ethers } from "ethers";

import {
  deserializeEvmOutput,
  serializeRespondOutput,
  type AbiDecodedOutput,
  type AbiSchemaInput,
  type EvmSchemaInput,
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
  const cases: Array<{
    name: string;
    schema: { name: string; type: string }[];
    encoded: unknown[];
    expected: AbiDecodedOutput;
  }> = [
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
      encoded
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

  const forms: Array<{ name: string; input: EvmSchemaInput }> = [
    { name: "typed array", input: schema },
    { name: "JSON string", input: JSON.stringify(schema) },
    { name: "raw JSON bytes", input: new TextEncoder().encode(JSON.stringify(schema)) },
    { name: "NUL-padded on-chain bytes", input: nulPadded(schema, 128) },
  ];

  it.each(forms)("$name", ({ input }) => {
    expect(deserializeEvmOutput(input, callResult)).toEqual(expected);
  });
});

describe("deserializeEvmOutput: rejections", () => {
  const good = coder.encode(["bool"], [true]);
  const cases: Array<{
    name: string;
    schema: EvmSchemaInput;
    callResult?: string;
    error?: RegExp;
  }> = [
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
      name: "empty schema array",
      schema: [],
      error: /non-empty/,
    },
    {
      name: "schema JSON that is not an array",
      schema: '{"name":"x","type":"bool"}',
      error: /non-empty JSON array/,
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
    const run = () => deserializeEvmOutput(schema, callResult ?? good);
    if (error) expect(run).toThrow(error);
    else expect(run).toThrow();
  });
});

// ===========================================================================
// serializeRespondOutput
// ===========================================================================

describe("serializeRespondOutput: byte-exact layout pins (circuit-verified)", () => {
  const cases: Array<{
    name: string;
    schema: AbiSchemaInput;
    output: AbiDecodedOutput;
    expectedHex: string;
  }> = [
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
        "02" + "00".repeat(7) +
        "07" + "00".repeat(15) +
        "08" + "00".repeat(15) +
        "00".repeat(16),
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

  const forms: Array<{ name: string; output: AbiDecodedOutput }> = [
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

  const forms: Array<{ name: string; input: AbiSchemaInput }> = [
    { name: "typed array", input: schema as AbiSchemaInput },
    { name: "JSON string", input: JSON.stringify(schema) },
    { name: "NUL-padded on-chain bytes", input: nulPadded(schema, 64) },
  ];

  it.each(forms)("$name", ({ input }) => {
    expect(hex(serializeRespondOutput(input, output))).toBe("01");
  });
});

describe("serializeRespondOutput: rejections", () => {
  const cases: Array<{
    name: string;
    schema: AbiSchemaInput;
    output: AbiDecodedOutput;
    error: RegExp;
  }> = [
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
      error: /no Compact carrier/,
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
    // touches; respond with the Compact-carrier subset, fields matched by name.
    const decodeSchema = [
      { name: "amount", type: "uint256" },
      { name: "delta", type: "int256" },
      { name: "ok", type: "bool" },
    ];
    const callResult = coder.encode(
      ["uint256", "int256", "bool"],
      [4242n, -5n, true]
    );
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
