// Is Compact's serialize<T, N> layout a subset of borsh? The executed answer,
// pinned against borsh-js (`borsh` on npm, NEAR's reference TypeScript
// implementation, test-only) restricted to its FIXED-length schemas: `bool`,
// the integers, `{ array: { type, len } }`, `{ struct }` and `{ enum }` of
// payload-free variants. `string`, `option`, length-prefixed arrays, `set`
// and `map` have no Compact counterpart and stay out of the comparison
// except where they are the tempting wrong twin (Option for Maybe, enum for
// Either).
//
// Verdict, every line pinned below (against the compiled circuits wherever
// compactc can compile the shape, against the twin elsewhere, and
// serde.test.ts pins the twin to the circuits):
//
//   SAME BYTES    Boolean. Uint at borsh's integer widths (1/2/4/8/16 bytes,
//                 sized or bounded). Bytes<n> as [u8; n]. Vector<n, T> as
//                 [T; n]. Structs. Tuples as positional structs. Enums of
//                 2..256 variants as payload-free borsh enums. Maybe<T> and
//                 Either<A, B> as the plain structs they are. Inside that
//                 core borsh is byte-identical in BOTH directions, and the
//                 seeded sweep at the end confirms it over generated shapes.
//
//   NO TWIN       Uint widths borsh has no integer for (3, 5..7, 9..15 and
//                 17..31 bytes: Uint<24>, Uint<40>, Uint<248>, Uint<0..70000>).
//                 Field (32 bytes, and borsh-js has no u256). The zero-width
//                 Uint<0..1> and single-variant enum (a borsh enum tag is
//                 always one byte). Enums past 256 variants (the one-byte
//                 tag wraps). Bytes<0> and Vector<0, T> (borsh-js emits a
//                 u32 length prefix for `len: 0`). A raw [u8; n] reproduces
//                 the bytes of the width cases, at the cost of typing a
//                 number as bytes.
//
//   SAME BYTES,   Maybe<T> is NOT borsh Option<T> (`none` keeps the value
//   OTHER RULES   arm). Either<A, B> is NOT a borsh enum (both arms always
//                 packed). serialize<T, N> pads where borsh never does.
//                 borsh-js reads a bool byte as `> 0` where the circuit
//                 reads `=== 1`. borsh range-checks nothing beyond the
//                 integer width (Uint<12> in a u16, Field in [u8; 32]).
//
// So the borsh-nameable core of the layout IS borsh, byte for byte, but the
// layout as a whole is not a subset of borsh: Compact has widths and
// zero-width types no borsh schema can name.

import { deserialize, type Schema, serialize } from "borsh";
import { describe, expect, it } from "vitest";

import {
  compactDeserialize,
  compactSerialize,
  compactSerializedSize,
  type CompactType,
  type CompactValue,
  FIELD_MODULUS,
} from "../src/index.ts";
import { pureCircuits } from "./fixtures/managed/contract/index.js";
import {
  BIG,
  BOUNDED,
  boundedValue,
  BUFFERS,
  buffersValue,
  EITHER,
  eitherBothArms,
  INNER,
  innerFalseValue,
  innerValue,
  MAYBE_U64,
  NESTED,
  nestedValue,
  PRIMITIVES,
  primitivesValue,
  SOLO,
  stdlibValue,
  TUPLE,
  TUPLE_PAIR,
  tuplePairValue,
  tupleValue,
  U12,
  VECTORS_DEEP,
  VECTORS_PLAIN,
  vectorsDeepValue,
  vectorsPlainValue,
  WIDE,
  WITH_STDLIB,
  ZERO_SIZES,
  zeroSizesValue,
} from "./fixtures/shapes.ts";
import { hex, mulberry32, randBigIntBelow, randInt, randValue, type Rng } from "./helpers.ts";

/**
 * The value shapes borsh-js takes and returns for the fixed-length schemas
 * used here: numbers for u8..u32, bigints for u64 and u128, plain arrays for
 * fixed arrays (deserialize returns `number[]` for `[u8; n]`, never a
 * Uint8Array), objects for structs and `{ Variant: {} }` for payload-free
 * enum variants.
 */
type BorshValue = boolean | number | bigint | BorshValue[] | { [key: string]: BorshValue };

/** What borsh-js's `deserialize` returns (the package does not export the alias). */
type BorshDecoded = ReturnType<typeof deserialize>;

/** A borsh enum of `n` payload-free variants V0..V{n-1}: a one-byte tag and nothing else. */
function unitVariants(n: number): Schema {
  return {
    enum: Array.from({ length: n }, (_, i) => ({ struct: { [`V${String(i)}`]: { struct: {} } } })),
  };
}

/** `n` copies of `byte` as the plain number array borsh-js reads [u8; n] into. */
function filled(n: number, byte: number): number[] {
  return Array.from({ length: n }, () => byte);
}

/** Right zero-padding, the `serialize<T, N>` step borsh has no notion of. */
function rightPad(bytes: Uint8Array, total: number): Uint8Array {
  const out = new Uint8Array(total);
  out.set(bytes);
  return out;
}

// ---- the borsh-expressible core ---------------------------------------------

interface CircuitPin {
  name: string;
  compact: CompactType;
  compactValue: CompactValue;
  borsh: Schema;
  borshValue: BorshValue;
  circuitSerialize: () => Uint8Array;
  circuitDeserialize: (bytes: Uint8Array) => CompactValue;
}

const PAIR_SCHEMA: Schema = { struct: { a: "u128", b: "u64" } };

const EITHER_SCHEMA: Schema = {
  struct: { is_left: "bool", left: "u64", right: { array: { type: "u8", len: 32 } } },
};

// Every fixture circuit whose Bytes<N> is the EXACT packed size, so the
// circuit output has no padding and must equal borsh's output outright.
const CIRCUIT_PINS: CircuitPin[] = [
  {
    name: "VectorsPlain: Vector<n, Uint<64 | 128>> is [u64 | u128; n]",
    compact: VECTORS_PLAIN,
    compactValue: vectorsPlainValue,
    borsh: {
      struct: {
        nums: { array: { type: "u64", len: 3 } },
        more: { array: { type: "u128", len: 2 } },
      },
    },
    borshValue: vectorsPlainValue,
    circuitSerialize: () => pureCircuits.serVectorsPlain(vectorsPlainValue),
    circuitDeserialize: (bytes) => pureCircuits.deVectorsPlain(bytes),
  },
  {
    name: "Inner: a struct in a struct, Boolean as bool",
    compact: INNER,
    compactValue: innerValue,
    borsh: { struct: { pair: PAIR_SCHEMA, ok: "bool" } },
    borshValue: innerValue,
    circuitSerialize: () => pureCircuits.serInner(innerValue),
    circuitDeserialize: (bytes) => pureCircuits.deInner(bytes),
  },
  {
    name: "Inner with a false Boolean (0x00 on both sides)",
    compact: INNER,
    compactValue: innerFalseValue,
    borsh: { struct: { pair: PAIR_SCHEMA, ok: "bool" } },
    borshValue: innerFalseValue,
    circuitSerialize: () => pureCircuits.serInner(innerFalseValue),
    circuitDeserialize: (bytes) => pureCircuits.deInner(bytes),
  },
  {
    name: "WithStdlib: ContractAddress as { bytes: [u8; 32] }, Maybe<Uint<64>> as a struct",
    compact: WITH_STDLIB,
    compactValue: stdlibValue,
    borsh: {
      struct: {
        owner: { struct: { bytes: { array: { type: "u8", len: 32 } } } },
        maybe: { struct: { is_some: "bool", value: "u64" } },
      },
    },
    borshValue: { owner: { bytes: filled(32, 0x5e) }, maybe: { is_some: true, value: 99n } },
    circuitSerialize: () => pureCircuits.serStdlib(stdlibValue),
    circuitDeserialize: (bytes) => pureCircuits.deStdlib(bytes),
  },
  {
    name: "tuple [Boolean, Uint<16>, Bytes<4>] as a positional struct",
    compact: TUPLE,
    compactValue: tupleValue,
    borsh: { struct: { _0: "bool", _1: "u16", _2: { array: { type: "u8", len: 4 } } } },
    borshValue: { _0: true, _1: 0x1234, _2: [1, 2, 3, 4] },
    circuitSerialize: () => pureCircuits.serTuple(tupleValue),
    circuitDeserialize: (bytes) => pureCircuits.deTuple(bytes),
  },
  {
    name: "tuple [Pair, Boolean] as a positional struct of a struct",
    compact: TUPLE_PAIR,
    compactValue: tuplePairValue,
    borsh: { struct: { _0: PAIR_SCHEMA, _1: "bool" } },
    borshValue: { _0: { a: 4242n, b: 7n }, _1: true },
    circuitSerialize: () => pureCircuits.serTuplePair(tuplePairValue),
    circuitDeserialize: (bytes) => pureCircuits.deTuplePair(bytes),
  },
  {
    name: "Uint<12>: ceil(12 / 8) = 2 bytes, the width of a u16",
    compact: U12,
    compactValue: 4095n,
    borsh: "u16",
    borshValue: 4095,
    circuitSerialize: () => pureCircuits.serU12(4095n),
    circuitDeserialize: (bytes) => pureCircuits.deU12(bytes),
  },
  {
    name: "Either<Uint<64>, Bytes<32>> with both arms populated, as the struct it is",
    compact: EITHER,
    compactValue: eitherBothArms,
    borsh: EITHER_SCHEMA,
    borshValue: { is_left: true, left: 4242n, right: filled(32, 0xab) },
    circuitSerialize: () => pureCircuits.serEither(eitherBothArms),
    circuitDeserialize: (bytes) => pureCircuits.deEither(bytes),
  },
  {
    name: "stdlib left(4242): the unused arm is zero-filled, still a struct to borsh",
    compact: EITHER,
    compactValue: { is_left: true, left: 4242n, right: new Uint8Array(32) },
    borsh: EITHER_SCHEMA,
    borshValue: { is_left: true, left: 4242n, right: filled(32, 0) },
    circuitSerialize: () => pureCircuits.serLeft(4242n),
    circuitDeserialize: (bytes) => pureCircuits.deEither(bytes),
  },
  {
    name: "stdlib right(0xab * 32): the unused arm is zero-filled, still a struct to borsh",
    compact: EITHER,
    compactValue: { is_left: false, left: 0n, right: new Uint8Array(32).fill(0xab) },
    borsh: EITHER_SCHEMA,
    borshValue: { is_left: false, left: 0n, right: filled(32, 0xab) },
    circuitSerialize: () => pureCircuits.serRight(new Uint8Array(32).fill(0xab)),
    circuitDeserialize: (bytes) => pureCircuits.deEither(bytes),
  },
];

describe("the borsh-expressible core: circuit, twin and borsh agree byte for byte", () => {
  it.each(CIRCUIT_PINS)(
    "$name",
    ({ compact, compactValue, borsh, borshValue, circuitSerialize, circuitDeserialize }) => {
      const circuitBytes = circuitSerialize();
      const borshBytes = serialize(borsh, borshValue);
      expect(hex(borshBytes)).toBe(hex(circuitBytes));
      expect(hex(compactSerialize(compact as never, compactValue as never))).toBe(
        hex(circuitBytes),
      );

      // Both directions: borsh reads what the circuit wrote, and the circuit
      // (and the strict twin) read what borsh wrote.
      expect(deserialize(borsh, circuitBytes)).toEqual(borshValue);
      expect(circuitDeserialize(borshBytes)).toEqual(compactValue);
      expect(compactDeserialize(compact, borshBytes)).toEqual(compactValue);
    },
  );
});

interface TwinPin {
  name: string;
  compact: CompactType;
  compactValue: CompactValue;
  borsh: Schema;
  borshValue: BorshValue;
}

// Shapes with no exact-size fixture circuit (serde.test.ts pins the twin
// itself to the circuits for every kind used here).
const TWIN_PINS: TwinPin[] = [
  {
    name: "Uint<8>, Uint<16>, Uint<32> are u8, u16, u32 (numbers in borsh-js)",
    compact: {
      kind: "tuple",
      elements: [
        { kind: "uint", bits: 8 },
        { kind: "uint", bits: 16 },
        { kind: "uint", bits: 32 },
      ],
    },
    compactValue: [255n, 65535n, 4294967295n],
    borsh: { struct: { _0: "u8", _1: "u16", _2: "u32" } },
    borshValue: { _0: 255, _1: 65535, _2: 4294967295 },
  },
  {
    name: "bounded Uint<0..1000> is a u16 (byteLength(999) = 2)",
    compact: { kind: "uint", bound: 1000 },
    compactValue: 999n,
    borsh: "u16",
    borshValue: 999,
  },
  {
    name: "the exclusive bound: Uint<0..256> is a u8, Uint<0..257> is a u16",
    compact: {
      kind: "tuple",
      elements: [
        { kind: "uint", bound: 256 },
        { kind: "uint", bound: 257 },
      ],
    },
    compactValue: [255n, 256n],
    borsh: { struct: { _0: "u8", _1: "u16" } },
    borshValue: { _0: 255, _1: 256 },
  },
  {
    name: "Bytes<20> is [u8; 20]",
    compact: { kind: "bytes", length: 20 },
    compactValue: new Uint8Array(20).fill(0x11),
    borsh: { array: { type: "u8", len: 20 } },
    borshValue: filled(20, 0x11),
  },
  {
    name: "a 3-variant enum is a payload-free borsh enum: the index IS the one-byte tag",
    compact: { kind: "enum", variants: 3 },
    compactValue: 2,
    borsh: {
      enum: [
        { struct: { V0: { struct: {} } } },
        { struct: { V1: { struct: {} } } },
        { struct: { V2: { struct: {} } } },
      ],
    },
    borshValue: { V2: {} },
  },
  {
    name: "a 256-variant enum: index 255 is the last one a borsh tag can hold",
    compact: { kind: "enum", variants: 256 },
    compactValue: 255,
    borsh: unitVariants(256),
    borshValue: { V255: {} },
  },
  {
    name: "VectorsDeep: [struct; n] and [[u8; 2]; 2] (compactc cannot serialize these, borsh can)",
    compact: VECTORS_DEEP,
    compactValue: vectorsDeepValue,
    borsh: {
      struct: {
        pairs: { array: { type: PAIR_SCHEMA, len: 2 } },
        matrix: { array: { type: { array: { type: "u8", len: 2 } }, len: 2 } },
      },
    },
    borshValue: {
      pairs: [
        { a: 4242n, b: 7n },
        { a: 0n, b: (1n << 64n) - 1n },
      ],
      matrix: [
        [1, 2],
        [3, 4],
      ],
    },
  },
  {
    name: "Nested: two levels of struct nesting",
    compact: NESTED,
    compactValue: nestedValue,
    borsh: {
      struct: {
        pair: PAIR_SCHEMA,
        inner: { struct: { pair: PAIR_SCHEMA, ok: "bool" } },
        ok: "bool",
      },
    },
    borshValue: nestedValue,
  },
  {
    name: "the empty struct is zero bytes on both sides",
    compact: { kind: "struct", fields: [] },
    compactValue: {},
    borsh: { struct: {} },
    borshValue: {},
  },
  {
    name: "Maybe<Uint<64>> none, as the struct it is",
    compact: MAYBE_U64,
    compactValue: { is_some: false, value: 0n },
    borsh: { struct: { is_some: "bool", value: "u64" } },
    borshValue: { is_some: false, value: 0n },
  },
];

describe("the borsh-expressible core: twin and borsh agree byte for byte", () => {
  it.each(TWIN_PINS)("$name", ({ compact, compactValue, borsh, borshValue }) => {
    const twinBytes = compactSerialize(compact as never, compactValue as never);
    const borshBytes = serialize(borsh, borshValue);
    expect(hex(borshBytes)).toBe(hex(twinBytes));
    expect(deserialize(borsh, twinBytes)).toEqual(borshValue);
    expect(compactDeserialize(compact, borshBytes)).toEqual(compactValue);
  });
});

describe("deserialize-only circuits read borsh bytes", () => {
  it("VectorsDeep: the circuit decodes what borsh encoded", () => {
    const borshBytes = serialize(
      {
        struct: {
          pairs: { array: { type: PAIR_SCHEMA, len: 2 } },
          matrix: { array: { type: { array: { type: "u8", len: 2 } }, len: 2 } },
        },
      },
      {
        pairs: [
          { a: 4242n, b: 7n },
          { a: 0n, b: (1n << 64n) - 1n },
        ],
        matrix: [
          [1, 2],
          [3, 4],
        ],
      },
    );
    expect(borshBytes).toHaveLength(52);
    expect(pureCircuits.deVectorsDeep(borshBytes)).toEqual(vectorsDeepValue);
  });

  it("Nested: the circuit decodes what borsh encoded, once padded to its Bytes<128>", () => {
    const borshBytes = serialize(
      {
        struct: {
          pair: PAIR_SCHEMA,
          inner: { struct: { pair: PAIR_SCHEMA, ok: "bool" } },
          ok: "bool",
        },
      },
      nestedValue,
    );
    expect(borshBytes).toHaveLength(50);
    expect(pureCircuits.deNested(rightPad(borshBytes, 128))).toEqual(nestedValue);
  });
});

// ---- what borsh cannot name --------------------------------------------------

describe("Compact widths borsh has no integer for", () => {
  it("borsh-js's integer vocabulary stops at u128: no u24, u40, u248 or u256", () => {
    for (const schema of ["u24", "u40", "u248", "u256"]) {
      expect(() => serialize(schema, 0)).toThrow(/Invalid schema/);
    }
  });

  it.each([
    { name: "Uint<24>", compact: { kind: "uint", bits: 24 }, packed: 3, nearest: "u32", zero: 0 },
    { name: "Uint<40>", compact: { kind: "uint", bits: 40 }, packed: 5, nearest: "u64", zero: 0n },
    {
      name: "Uint<248> (the widest Compact Uint)",
      compact: { kind: "uint", bits: 248 },
      packed: 31,
      nearest: "u128",
      zero: 0n,
    },
    { name: "Uint<0..70000>", compact: WIDE, packed: 3, nearest: "u32", zero: 0 },
    { name: "Field", compact: { kind: "field" }, packed: 32, nearest: "u128", zero: 0n },
  ] satisfies {
    name: string;
    compact: CompactType;
    packed: number;
    nearest: Schema;
    zero: BorshValue;
  }[])(
    "$name packs to $packed bytes; the nearest borsh integer $nearest does not",
    ({ compact, packed, nearest, zero }) => {
      expect(compactSerializedSize(compact)).toBe(packed);
      expect(serialize(nearest, zero)).not.toHaveLength(packed);
    },
  );

  it("only a raw [u8; n] reproduces those bytes, and it types the value as bytes", () => {
    // Uint<0..70000> = 69999 is 6f 11 01 in the circuit (serde.test.ts pins it).
    const asBytes: Schema = { array: { type: "u8", len: 3 } };
    expect(hex(serialize(asBytes, [0x6f, 0x11, 0x01]))).toBe(hex(pureCircuits.serWide(69999n)));
    expect(deserialize(asBytes, pureCircuits.serWide(69999n))).toEqual([0x6f, 0x11, 0x01]);

    // The whole Primitives struct, with Uint<248> and Field as [u8; 31] and
    // [u8; 32]: the circuit's bytes exactly, the numbers gone.
    const primitivesAsBytes: Schema = {
      struct: {
        flag: "bool",
        u8: "u8",
        u64: "u64",
        u128: "u128",
        u248: { array: { type: "u8", len: 31 } },
        f: { array: { type: "u8", len: 32 } },
      },
    };
    const borshBytes = serialize(primitivesAsBytes, {
      flag: true,
      u8: 255,
      u64: (1n << 64n) - 1n,
      u128: 123456789n,
      u248: filled(31, 0xff),
      f: Array.from(compactSerialize({ kind: "field" }, FIELD_MODULUS - 1n)),
    });
    expect(hex(borshBytes)).toBe(hex(pureCircuits.serPrimitives(primitivesValue)));
    expect(pureCircuits.dePrimitives(borshBytes)).toEqual(primitivesValue);
    expect(compactDeserialize(PRIMITIVES, borshBytes)).toEqual(primitivesValue);
  });

  it("the README examples: Uint<0..70000> in a u32, Uint<248> max in a u128 (silently truncated)", () => {
    expect(hex(compactSerialize(WIDE, 69999n))).toBe("6f1101");
    expect(hex(serialize("u32", 69999))).toBe("6f110100");

    const max248 = (1n << 248n) - 1n;
    expect(hex(compactSerialize({ kind: "uint", bits: 248 }, max248))).toBe("ff".repeat(31));
    // borsh-js keeps the low 16 bytes and drops the rest without an error.
    expect(hex(serialize("u128", max248))).toBe("ff".repeat(16));
    expect(deserialize("u128", serialize("u128", max248))).toBe((1n << 128n) - 1n);

    expect(hex(compactSerialize({ kind: "field" }, FIELD_MODULUS - 1n))).toBe(
      "00000000fffffffffe5bfeff02a4bd5305d8a10908d83933487d9d2953a7ed73",
    );
  });
});

describe("zero-width Compact types have no borsh counterpart", () => {
  it("Uint<0..1> is zero bytes; the narrowest borsh integer is one", () => {
    // Bounded = { small: Uint<0..1000>, unit: Uint<0..1>, status: 3-variant
    // enum, marker: Uint<8> }, packed as e703 | (nothing) | 02 | aa.
    expect(hex(compactSerialize(BOUNDED, boundedValue))).toBe("e70302aa");
    expect(hex(pureCircuits.serBounded(boundedValue))).toBe("e70302aa00000000");
    expect(
      hex(
        serialize(
          { struct: { small: "u16", unit: "u8", status: unitVariants(3), marker: "u8" } },
          { small: 999, unit: 0, status: { V2: {} }, marker: 0xaa },
        ),
      ),
    ).toBe("e7030002aa");
  });

  it("a single-variant enum is zero bytes; a borsh enum tag is always one", () => {
    expect(compactSerializedSize(SOLO)).toBe(0);
    // serSolo's Bytes<1> output is pure padding (serde.test.ts pins "00").
    expect(hex(pureCircuits.serSolo(0))).toBe("00");
    const soloThenMarker: CompactType = {
      kind: "tuple",
      elements: [SOLO, { kind: "uint", bits: 8 }],
    };
    expect(hex(compactSerialize(soloThenMarker, [0, 0xaan]))).toBe("aa");
    expect(
      hex(serialize({ struct: { _0: unitVariants(1), _1: "u8" } }, { _0: { V0: {} }, _1: 0xaa })),
    ).toBe("00aa");
  });

  it("Bytes<0> and Vector<0, T>: borsh-js length-prefixes a `len: 0` array", () => {
    // ZeroSizes = { empty: Bytes<0>, none: Vector<0, Uint<64>>, nothing: {},
    // marker: Uint<8> }: one byte in Compact.
    expect(hex(pureCircuits.serZeroSizes(zeroSizesValue))).toBe("5a");
    expect(hex(compactSerialize(ZERO_SIZES, zeroSizesValue))).toBe("5a");
    expect(
      hex(
        serialize(
          {
            struct: {
              empty: { array: { type: "u8", len: 0 } },
              none: { array: { type: "u64", len: 0 } },
              nothing: { struct: {} },
              marker: "u8",
            },
          },
          { empty: [], none: [], nothing: {}, marker: 0x5a },
        ),
      ),
    ).toBe("00000000" + "00000000" + "5a");
  });
});

describe("enums past 256 variants", () => {
  it("a 300-variant enum is Uint<0..300>, two bytes; borsh-js's one-byte tag wraps", () => {
    expect(hex(pureCircuits.serBig(299))).toBe("2b01");
    expect(hex(compactSerialize(BIG, 299))).toBe("2b01");
    const borshBytes = serialize(unitVariants(300), { V299: {} });
    expect(hex(borshBytes)).toBe("2b");
    expect(deserialize(unitVariants(300), borshBytes)).toEqual({ V43: {} });
  });
});

// ---- a real request struct ---------------------------------------------------

// signet-midnight's EvmType2TxParams<1, 0, 0> as the test caller builds it:
// every field is inside the borsh core EXCEPT the empty access list
// (Vector<0, EvmAccessListEntry<0>>), and the calldata is a Maybe.
const EVM_CALLDATA_1 = {
  kind: "struct",
  fields: [
    { name: "selector", type: { kind: "bytes", length: 4 } },
    { name: "noWords", type: { kind: "uint", bits: 16 } },
    { name: "words", type: { kind: "vector", length: 1, element: { kind: "bytes", length: 32 } } },
  ],
} as const satisfies CompactType;

const EVM_ACCESS_LIST_ENTRY_0 = {
  kind: "struct",
  fields: [
    { name: "address", type: { kind: "bytes", length: 20 } },
    { name: "storageKeyCount", type: { kind: "uint", bits: 8 } },
    {
      name: "storageKeys",
      type: { kind: "vector", length: 0, element: { kind: "bytes", length: 32 } },
    },
  ],
} as const satisfies CompactType;

const EVM_TYPE2_TX_PARAMS_1_0_0 = {
  kind: "struct",
  fields: [
    { name: "chainId", type: { kind: "uint", bits: 64 } },
    { name: "nonce", type: { kind: "uint", bits: 64 } },
    { name: "maxPriorityFeePerGas", type: { kind: "uint", bits: 128 } },
    { name: "maxFeePerGas", type: { kind: "uint", bits: 128 } },
    { name: "gasLimit", type: { kind: "uint", bits: 64 } },
    { name: "to", type: { kind: "bytes", length: 20 } },
    { name: "value", type: { kind: "uint", bits: 128 } },
    {
      name: "calldata",
      type: {
        kind: "struct",
        fields: [
          { name: "is_some", type: { kind: "boolean" } },
          { name: "value", type: EVM_CALLDATA_1 },
        ],
      },
    },
    { name: "accessListEntryCount", type: { kind: "uint", bits: 8 } },
    { name: "accessList", type: { kind: "vector", length: 0, element: EVM_ACCESS_LIST_ENTRY_0 } },
  ],
} as const satisfies CompactType;

const WORD_SCHEMA: Schema = { array: { type: "u8", len: 32 } };

const EVM_TYPE2_TX_PARAMS_1_0_0_SCHEMA: Schema = {
  struct: {
    chainId: "u64",
    nonce: "u64",
    maxPriorityFeePerGas: "u128",
    maxFeePerGas: "u128",
    gasLimit: "u64",
    to: { array: { type: "u8", len: 20 } },
    value: "u128",
    calldata: {
      struct: {
        is_some: "bool",
        value: {
          struct: {
            selector: { array: { type: "u8", len: 4 } },
            noWords: "u16",
            words: { array: { type: WORD_SCHEMA, len: 1 } },
          },
        },
      },
    },
    accessListEntryCount: "u8",
    accessList: {
      array: {
        type: {
          struct: {
            address: { array: { type: "u8", len: 20 } },
            storageKeyCount: "u8",
            storageKeys: { array: { type: WORD_SCHEMA, len: 0 } },
          },
        },
        len: 0,
      },
    },
  },
};

// The test caller's submitCheckAndDoubleRequest values (nonce 5, a
// 0x11-filled target, a 0x22-filled argument word).
const txParamsValue = {
  chainId: 31337n,
  nonce: 5n,
  maxPriorityFeePerGas: 1000000000n,
  maxFeePerGas: 30000000000n,
  gasLimit: 100000n,
  to: new Uint8Array(20).fill(0x11),
  value: 0n,
  calldata: {
    is_some: true,
    value: {
      selector: Uint8Array.of(0xe6, 0xcf, 0x21, 0x87),
      noWords: 1n,
      words: [new Uint8Array(32).fill(0x22)],
    },
  },
  accessListEntryCount: 0n,
  accessList: [],
};

describe("a real request struct: EvmType2TxParams<1, 0, 0>", () => {
  it("packs to 132 bytes; borsh-js appends a 4-byte length for the empty access list", () => {
    const twinBytes = compactSerialize(EVM_TYPE2_TX_PARAMS_1_0_0, txParamsValue);
    expect(twinBytes).toHaveLength(132);
    const borshBytes = serialize(EVM_TYPE2_TX_PARAMS_1_0_0_SCHEMA, {
      ...txParamsValue,
      to: filled(20, 0x11),
      calldata: {
        is_some: true,
        value: { selector: [0xe6, 0xcf, 0x21, 0x87], noWords: 1, words: [filled(32, 0x22)] },
      },
      accessListEntryCount: 0,
    });
    expect(borshBytes).toHaveLength(136);
    expect(hex(borshBytes)).toBe(hex(twinBytes) + "00000000");
    // The four extra bytes are zero, so the strict twin reads them as
    // padding. A contract reading Bytes<132> never sees them, and one
    // reading Bytes<136> ignores them as padding too.
    expect(compactDeserialize(EVM_TYPE2_TX_PARAMS_1_0_0, borshBytes)).toEqual(txParamsValue);
  });

  it("calldata none keeps its 39 zero bytes where borsh Option would keep one", () => {
    const noneValue = {
      ...txParamsValue,
      calldata: {
        is_some: false,
        value: { selector: new Uint8Array(4), noWords: 0n, words: [new Uint8Array(32)] },
      },
    };
    const twinBytes = compactSerialize(EVM_TYPE2_TX_PARAMS_1_0_0, noneValue);
    expect(twinBytes).toHaveLength(132);
    expect(hex(twinBytes.subarray(92, 131))).toBe("00".repeat(39));
    expect(serialize({ option: "u8" }, null)).toHaveLength(1);
  });
});

// ---- same bytes, other rules -------------------------------------------------

describe("same bytes, other rules", () => {
  it("Maybe<T> is not borsh Option<T>: `none` keeps the value arm", () => {
    const none = pureCircuits.serNoneU64();
    expect(hex(none)).toBe("00" + "0000000000000000");
    expect(hex(serialize({ option: "u64" }, null))).toBe("00");
    // `some` coincides: a 0x01 tag followed by the value, either way.
    expect(hex(serialize({ option: "u64" }, 99n))).toBe(hex(pureCircuits.serSomeU64(99n)));
    // The struct schema is the faithful twin for both.
    const asStruct: Schema = { struct: { is_some: "bool", value: "u64" } };
    expect(hex(serialize(asStruct, { is_some: false, value: 0n }))).toBe(hex(none));
    expect(hex(serialize(asStruct, { is_some: true, value: 99n }))).toBe(
      hex(pureCircuits.serSomeU64(99n)),
    );
  });

  it("Either<A, B> is not a borsh enum: both arms always occupy their width", () => {
    const asEnum: Schema = {
      enum: [
        { struct: { Left: "u64" } },
        { struct: { Right: { array: { type: "u8", len: 32 } } } },
      ],
    };
    expect(pureCircuits.serLeft(4242n)).toHaveLength(41);
    expect(serialize(asEnum, { Left: 4242n })).toHaveLength(9);
    expect(pureCircuits.serRight(new Uint8Array(32).fill(0xab))).toHaveLength(41);
    expect(serialize(asEnum, { Right: filled(32, 0xab) })).toHaveLength(33);
  });

  it("serialize<T, N> pads to N; borsh never pads, and borsh-js reads a prefix", () => {
    // Buffers packs to 53 bytes. The fixture circuit returns Bytes<64>.
    const circuitBytes = pureCircuits.serBuffers(buffersValue);
    expect(circuitBytes).toHaveLength(64);
    const schema: Schema = {
      struct: {
        one: { array: { type: "u8", len: 1 } },
        addr20: { array: { type: "u8", len: 20 } },
        word: { array: { type: "u8", len: 32 } },
      },
    };
    const borshValue = { one: [0x7f], addr20: filled(20, 0x11), word: filled(32, 0xab) };
    const borshBytes = serialize(schema, borshValue);
    expect(borshBytes).toHaveLength(53);
    expect(hex(circuitBytes)).toBe(hex(borshBytes) + "00".repeat(11));
    // borsh-js stops after the schema and ignores what follows.
    expect(deserialize(schema, circuitBytes)).toEqual(borshValue);
    expect(compactDeserialize(BUFFERS, circuitBytes)).toEqual(buffersValue);
  });

  it("a Boolean byte of 0x02: borsh-js reads true, the circuit reads false, the twin rejects", () => {
    expect(deserialize("bool", Uint8Array.of(0x02))).toBe(true);
    const bytes = compactSerialize(INNER, innerValue, 25);
    bytes[24] = 0x02;
    expect(pureCircuits.deInner(bytes).ok).toBe(false);
    expect(() => compactDeserialize(INNER, bytes)).toThrow(/boolean/);
  });

  it("borsh checks only the width: 4096 fits a u16 but not Uint<12>", () => {
    const borshBytes = serialize("u16", 4096);
    expect(hex(borshBytes)).toBe("0010");
    expect(() => compactSerialize(U12, 4096n)).toThrow(/exceeds Uint<12>/);
    expect(() => pureCircuits.deU12(borshBytes)).toThrow();
    expect(() => compactDeserialize(U12, borshBytes)).toThrow();
  });

  it("borsh checks only the width: the Field modulus fits [u8; 32] but is not a Field", () => {
    let modulus = FIELD_MODULUS;
    const modulusLE: number[] = [];
    for (let i = 0; i < 32; i++) {
      modulusLE.push(Number(modulus & 0xffn));
      modulus >>= 8n;
    }
    const borshBytes = serialize({ array: { type: "u8", len: 32 } }, modulusLE);
    expect(deserialize({ array: { type: "u8", len: 32 } }, borshBytes)).toEqual(modulusLE);
    expect(() => compactDeserialize({ kind: "field" }, borshBytes)).toThrow(/Field modulus/);
  });
});

// ---- seeded sweep over the borsh-expressible core ---------------------------

/** Compact Uint byte widths that are also borsh integer widths. */
const BORSH_WIDTHS = [1, 2, 4, 8, 16] as const;

/** A random descriptor drawn only from the shapes borsh can name (see the header). */
function randBorshCoreType(rng: Rng, depth: number): CompactType {
  const leaves = ["boolean", "uintBits", "uintBound", "bytes", "enum"] as const;
  const all = [...leaves, "vector", "tuple", "struct"] as const;
  const pool: readonly (typeof all)[number][] = depth > 0 ? [...all] : [...leaves];
  const pick = pool[randInt(rng, 0, pool.length - 1)];
  const width = BORSH_WIDTHS[randInt(rng, 0, BORSH_WIDTHS.length - 1)] ?? 1;
  switch (pick) {
    case "boolean":
      return { kind: "boolean" };
    case "uintBits":
      return { kind: "uint", bits: width * 8 };
    case "uintBound": {
      // A bound whose byteLength(bound - 1) is exactly `width`: one above
      // (256^(width-1), 256^width].
      const low = width === 1 ? 1n : 1n << BigInt(8 * (width - 1));
      const high = 1n << BigInt(8 * width);
      const bound = low + 1n + randBigIntBelow(rng, high - low);
      return bound <= BigInt(Number.MAX_SAFE_INTEGER) && rng() < 0.5
        ? { kind: "uint", bound: Number(bound) }
        : { kind: "uint", bound };
    }
    case "bytes":
      return { kind: "bytes", length: randInt(rng, 1, 24) };
    case "enum":
      return { kind: "enum", variants: randInt(rng, 2, 256) };
    case "vector":
      return {
        kind: "vector",
        length: randInt(rng, 1, 3),
        element: randBorshCoreType(rng, depth - 1),
      };
    case "tuple": {
      const elements = Array.from({ length: randInt(rng, 1, 3) }, () =>
        randBorshCoreType(rng, depth - 1),
      );
      return { kind: "tuple", elements };
    }
    case "struct": {
      const fields = Array.from({ length: randInt(rng, 1, 3) }, (_, i) => ({
        name: `f${String(i)}`,
        type: randBorshCoreType(rng, depth - 1),
      }));
      return { kind: "struct", fields };
    }
    default:
      throw new Error(`randBorshCoreType picked nothing from a pool of ${String(pool.length)}`);
  }
}

/**
 * The borsh schema of a borsh-core descriptor. Integer widths come from the
 * twin's own size computation, which is fine here: borsh-js derives its
 * byte count from the schema name independently, so a twin width bug still
 * shows up as a byte mismatch.
 *
 * @throws {Error} For a descriptor outside the borsh-nameable core.
 */
function borshSchemaOf(type: CompactType): Schema {
  switch (type.kind) {
    case "boolean":
      return "bool";
    case "uint": {
      const width = compactSerializedSize(type);
      if (!BORSH_WIDTHS.some((w) => w === width)) {
        throw new Error(`no borsh integer is ${String(width)} bytes wide`);
      }
      return `u${String(width * 8)}`;
    }
    case "field":
      throw new Error("Field has no borsh integer (32 bytes)");
    case "bytes":
      return { array: { type: "u8", len: type.length } };
    case "enum":
      return unitVariants(type.variants);
    case "vector":
      return { array: { type: borshSchemaOf(type.element), len: type.length } };
    case "tuple":
      return {
        struct: Object.fromEntries(
          type.elements.map((e, i) => [`_${String(i)}`, borshSchemaOf(e)]),
        ),
      };
    case "struct":
      return {
        struct: Object.fromEntries(type.fields.map((f) => [f.name, borshSchemaOf(f.type)])),
      };
  }
}

/**
 * The borsh-js value for a twin value: numbers below u64, bigints from u64,
 * plain arrays for bytes, `{ V<i>: {} }` for enum variants, positional
 * objects for tuples.
 *
 * @throws {Error} If the value does not match the descriptor.
 */
function toBorshValue(type: CompactType, value: CompactValue): BorshValue {
  switch (type.kind) {
    case "boolean":
      if (typeof value !== "boolean") throw new Error("expected boolean");
      return value;
    case "uint":
      if (typeof value !== "bigint") throw new Error("expected bigint");
      return compactSerializedSize(type) <= 4 ? Number(value) : value;
    case "field":
      throw new Error("Field has no borsh integer (32 bytes)");
    case "bytes":
      if (!(value instanceof Uint8Array)) throw new Error("expected Uint8Array");
      return Array.from(value);
    case "enum":
      if (typeof value !== "number") throw new Error("expected number");
      return { [`V${String(value)}`]: {} };
    case "vector":
      if (!Array.isArray(value)) throw new Error("expected array");
      return value.map((element) => toBorshValue(type.element, element));
    case "tuple":
      if (!Array.isArray(value)) throw new Error("expected array");
      return Object.fromEntries(
        type.elements.map((e, i) => {
          const element = value[i];
          if (element === undefined) throw new Error("missing tuple element");
          return [`_${String(i)}`, toBorshValue(e, element)];
        }),
      );
    case "struct": {
      if (typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) {
        throw new Error("expected object");
      }
      return Object.fromEntries(
        type.fields.map((f) => {
          const field = value[f.name];
          if (field === undefined) throw new Error(`missing field ${f.name}`);
          return [f.name, toBorshValue(f.type, field)];
        }),
      );
    }
  }
}

/** `Array.isArray` narrows borsh's `object` member to `any[]`; this keeps the elements typed. */
function isDecodedArray(decoded: BorshDecoded): decoded is BorshDecoded[] {
  return Array.isArray(decoded);
}

/**
 * The twin value for what borsh-js decoded: the inverse of {@link toBorshValue}.
 *
 * @throws {Error} If the decoded value does not match the descriptor.
 */
function fromBorshValue(type: CompactType, decoded: BorshDecoded): CompactValue {
  switch (type.kind) {
    case "boolean":
      if (typeof decoded !== "boolean") throw new Error("expected boolean");
      return decoded;
    case "uint":
      if (typeof decoded === "number") return BigInt(decoded);
      if (typeof decoded === "bigint") return decoded;
      throw new Error("expected number or bigint");
    case "field":
      throw new Error("Field has no borsh integer (32 bytes)");
    case "bytes":
      if (!isDecodedArray(decoded)) throw new Error("expected array");
      return Uint8Array.from(decoded.map((b) => (typeof b === "number" ? b : NaN)));
    case "enum": {
      if (typeof decoded !== "object" || decoded === null) throw new Error("expected object");
      const match = /^V(\d+)$/.exec(Object.keys(decoded).join(","));
      if (match?.[1] === undefined) throw new Error("expected a single V<i> variant key");
      return Number(match[1]);
    }
    case "vector":
      if (!isDecodedArray(decoded)) throw new Error("expected array");
      return decoded.map((element) => fromBorshValue(type.element, element));
    case "tuple": {
      if (typeof decoded !== "object" || decoded === null) throw new Error("expected object");
      const record = decoded as Record<string, BorshDecoded>;
      return type.elements.map((e, i) => {
        const element = record[`_${String(i)}`];
        if (element === undefined) throw new Error("missing tuple element");
        return fromBorshValue(e, element);
      });
    }
    case "struct": {
      if (typeof decoded !== "object" || decoded === null) throw new Error("expected object");
      const record = decoded as Record<string, BorshDecoded>;
      const value: Record<string, CompactValue> = {};
      for (const f of type.fields) {
        const field = record[f.name];
        if (field === undefined) throw new Error(`missing field ${f.name}`);
        value[f.name] = fromBorshValue(f.type, field);
      }
      return value;
    }
  }
}

/** Every descriptor kind reachable in a tree, for the coverage guard below. */
function kindsIn(type: CompactType): CompactType["kind"][] {
  switch (type.kind) {
    case "vector":
      return [type.kind, ...kindsIn(type.element)];
    case "tuple":
      return [type.kind, ...type.elements.flatMap(kindsIn)];
    case "struct":
      return [type.kind, ...type.fields.flatMap((f) => kindsIn(f.type))];
    default:
      return [type.kind];
  }
}

const CASES = 300;

describe(`seeded sweep: ${String(CASES)} borsh-core descriptor/value pairs (seed 0xB0B5)`, () => {
  const rng = mulberry32(0xb0b5);
  const cases = Array.from({ length: CASES }, () => {
    const type = randBorshCoreType(rng, 3);
    return { type, value: randValue(rng, type), schema: borshSchemaOf(type) };
  });

  it("the generator reaches every borsh-nameable kind", () => {
    const kinds = new Set(cases.flatMap(({ type }) => kindsIn(type)));
    expect([...kinds].sort()).toEqual(
      ["boolean", "bytes", "enum", "struct", "tuple", "uint", "vector"].sort(),
    );
  });

  it("borsh serialize equals twin serialize", () => {
    for (const { type, value, schema } of cases) {
      expect(hex(serialize(schema, toBorshValue(type, value)))).toBe(
        hex(compactSerialize(type as never, value as never)),
      );
    }
  });

  it("borsh deserialize of twin bytes maps back to the value", () => {
    for (const { type, value, schema } of cases) {
      const decoded = deserialize(schema, compactSerialize(type as never, value as never));
      expect(fromBorshValue(type, decoded)).toEqual(value);
    }
  });

  it("strict twin decode of borsh bytes returns the value", () => {
    for (const { type, value, schema } of cases) {
      const borshBytes = serialize(schema, toBorshValue(type, value));
      expect(compactDeserialize(type, borshBytes)).toEqual(value);
    }
  });
});
