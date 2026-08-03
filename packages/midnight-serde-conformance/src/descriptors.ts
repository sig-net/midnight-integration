// The shared descriptor tables and fixture values mirroring
// serde-fixtures.compact, extracted here so the corpus generator, the
// TypeScript twin's tests and (via the generated corpus) the Rust twin all
// pin against ONE set of shapes. Every descriptor keeps its literal type
// (`as const satisfies CompactType`) so CompactValueOf inference works in
// consumers.

import { FIELD_MODULUS, type CompactType, type CompactValue } from '@sig-net/midnight-serde';

/** UintPair building block: `struct Pair { a: Uint<128>; b: Uint<64> }`. */
export const PAIR = {
  kind: 'struct',
  fields: [
    { name: 'a', type: { kind: 'uint', bits: 128 } },
    { name: 'b', type: { kind: 'uint', bits: 64 } },
  ],
} as const satisfies CompactType;

/** Every primitive kind at boundary widths: fixture struct `Primitives`. */
export const PRIMITIVES = {
  kind: 'struct',
  fields: [
    { name: 'flag', type: { kind: 'boolean' } },
    { name: 'u8', type: { kind: 'uint', bits: 8 } },
    { name: 'u64', type: { kind: 'uint', bits: 64 } },
    { name: 'u128', type: { kind: 'uint', bits: 128 } },
    { name: 'u248', type: { kind: 'uint', bits: 248 } },
    { name: 'f', type: { kind: 'field' } },
  ],
} as const satisfies CompactType;

/** `Bytes<N>` at 1, 20 (EVM address width) and 32: fixture struct `Buffers`. */
export const BUFFERS = {
  kind: 'struct',
  fields: [
    { name: 'one', type: { kind: 'bytes', length: 1 } },
    { name: 'addr20', type: { kind: 'bytes', length: 20 } },
    { name: 'word', type: { kind: 'bytes', length: 32 } },
  ],
} as const satisfies CompactType;

/** Vectors of uints: fixture struct `VectorsPlain`. */
export const VECTORS_PLAIN = {
  kind: 'struct',
  fields: [
    { name: 'nums', type: { kind: 'vector', length: 3, element: { kind: 'uint', bits: 64 } } },
    { name: 'more', type: { kind: 'vector', length: 2, element: { kind: 'uint', bits: 128 } } },
  ],
} as const satisfies CompactType;

/**
 * Vector of STRUCTS plus vector of VECTORS: deserialize-only in-circuit
 * (compactc 0.33 crashes compiling `serialize<T, N>` for these shapes).
 */
export const VECTORS_DEEP = {
  kind: 'struct',
  fields: [
    { name: 'pairs', type: { kind: 'vector', length: 2, element: PAIR } },
    {
      name: 'matrix',
      type: {
        kind: 'vector',
        length: 2,
        element: { kind: 'vector', length: 2, element: { kind: 'uint', bits: 8 } },
      },
    },
  ],
} as const satisfies CompactType;

/** One level of struct nesting: fixture struct `Inner`. */
export const INNER = {
  kind: 'struct',
  fields: [
    { name: 'pair', type: PAIR },
    { name: 'ok', type: { kind: 'boolean' } },
  ],
} as const satisfies CompactType;

/** Two levels of struct nesting: deserialize-only in-circuit (same compactc bug). */
export const NESTED = {
  kind: 'struct',
  fields: [
    { name: 'pair', type: PAIR },
    { name: 'inner', type: INNER },
    { name: 'ok', type: { kind: 'boolean' } },
  ],
} as const satisfies CompactType;

/**
 * Stdlib types as plain structs: ContractAddress is `{ bytes: Bytes<32> }`,
 * Maybe<Uint<64>> is `{ is_some: Boolean; value: Uint<64> }`.
 */
export const WITH_STDLIB = {
  kind: 'struct',
  fields: [
    {
      name: 'owner',
      type: { kind: 'struct', fields: [{ name: 'bytes', type: { kind: 'bytes', length: 32 } }] },
    },
    {
      name: 'maybe',
      type: {
        kind: 'struct',
        fields: [
          { name: 'is_some', type: { kind: 'boolean' } },
          { name: 'value', type: { kind: 'uint', bits: 64 } },
        ],
      },
    },
  ],
} as const satisfies CompactType;

/**
 * Bounded uints and an enum. The `Uint<0..n>` upper bound is EXCLUSIVE:
 * `Uint<0..1000>` holds 0..999 in 2 bytes, `Uint<0..1>` holds only 0 in ZERO
 * bytes, and a 3-variant enum is `Uint<0..3>` in 1 byte.
 */
export const BOUNDED = {
  kind: 'struct',
  fields: [
    { name: 'small', type: { kind: 'uint', bound: 1000 } },
    { name: 'unit', type: { kind: 'uint', bound: 1 } },
    { name: 'status', type: { kind: 'enum', variants: 3 } },
    { name: 'marker', type: { kind: 'uint', bits: 8 } },
  ],
} as const satisfies CompactType;

/** All the zero-width shapes beside a 1-byte marker: fixture struct `ZeroSizes`. */
export const ZERO_SIZES = {
  kind: 'struct',
  fields: [
    { name: 'empty', type: { kind: 'bytes', length: 0 } },
    { name: 'none', type: { kind: 'vector', length: 0, element: { kind: 'uint', bits: 64 } } },
    { name: 'nothing', type: { kind: 'struct', fields: [] } },
    { name: 'marker', type: { kind: 'uint', bits: 8 } },
  ],
} as const satisfies CompactType;

/** Heterogeneous tuple `[Boolean, Uint<16>, Bytes<4>]`. */
export const TUPLE = {
  kind: 'tuple',
  elements: [
    { kind: 'boolean' },
    { kind: 'uint', bits: 16 },
    { kind: 'bytes', length: 4 },
  ],
} as const satisfies CompactType;

/** Tuple CONTAINING a struct (compiles in-circuit, unlike Vector<n, Struct>). */
export const TUPLE_PAIR = {
  kind: 'tuple',
  elements: [PAIR, { kind: 'boolean' }],
} as const satisfies CompactType;

/** Non-byte-aligned sized uint: 2 bytes, decode-rejected at 4096. */
export const U12 = { kind: 'uint', bits: 12 } as const satisfies CompactType;

/** 3-byte bounded uint (byteLength(69999) = 3), decode-rejected at 70000. */
export const WIDE = { kind: 'uint', bound: 70000 } as const satisfies CompactType;

/** Single-variant enum: ZERO bytes wide. */
export const SOLO = { kind: 'enum', variants: 1 } as const satisfies CompactType;

/** The empty tuple `[]`: ZERO bytes wide. */
export const EMPTY_TUPLE = { kind: 'tuple', elements: [] } as const satisfies CompactType;

/** A 300-variant enum: TWO bytes little-endian, decode-rejected at index 300. */
export const BIG = { kind: 'enum', variants: 300 } as const satisfies CompactType;

/**
 * Stdlib Either<Uint<64>, Bytes<32>> as a plain struct: BOTH arms always
 * occupy their full width regardless of the tag.
 */
export const EITHER = {
  kind: 'struct',
  fields: [
    { name: 'is_left', type: { kind: 'boolean' } },
    { name: 'left', type: { kind: 'uint', bits: 64 } },
    { name: 'right', type: { kind: 'bytes', length: 32 } },
  ],
} as const satisfies CompactType;

/** Stdlib Maybe<Uint<64>> as a plain struct. */
export const MAYBE_U64 = {
  kind: 'struct',
  fields: [
    { name: 'is_some', type: { kind: 'boolean' } },
    { name: 'value', type: { kind: 'uint', bits: 64 } },
  ],
} as const satisfies CompactType;

// ---- fixture values --------------------------------------------------------

/** Boundary values for {@link PRIMITIVES}: max u64/u248, max legal Field. */
export const primitivesValue = {
  flag: true,
  u8: 255n,
  u64: (1n << 64n) - 1n,
  u128: 123456789n,
  u248: (1n << 248n) - 1n,
  f: FIELD_MODULUS - 1n,
};

/** Recognisable byte patterns for {@link BUFFERS}. */
export const buffersValue = {
  one: Uint8Array.of(0x7f),
  addr20: new Uint8Array(20).fill(0x11),
  word: new Uint8Array(32).fill(0xab),
};

/** Values for {@link VECTORS_PLAIN}, including a max u128 element. */
export const vectorsPlainValue = {
  nums: [1n, 2n, 3n],
  more: [(1n << 128n) - 1n, 0n],
};

/** Values for {@link VECTORS_DEEP}. */
export const vectorsDeepValue = {
  pairs: [
    { a: 4242n, b: 7n },
    { a: 0n, b: (1n << 64n) - 1n },
  ],
  matrix: [
    [1n, 2n],
    [3n, 4n],
  ],
};

/** Value for {@link INNER} with a true boolean. */
export const innerValue = { pair: { a: 4242n, b: 7n }, ok: true };

/**
 * Value for {@link INNER} with a FALSE boolean: every other ser fixture value
 * carries `true`, so this one pins the circuit serializing 0x00.
 */
export const innerFalseValue = { pair: { a: 4242n, b: 7n }, ok: false };

/** Value for {@link NESTED}. */
export const nestedValue = {
  pair: { a: 1n, b: 2n },
  inner: { pair: { a: 3n, b: 4n }, ok: false },
  ok: true,
};

/** Value for {@link WITH_STDLIB}. */
export const stdlibValue = {
  owner: { bytes: new Uint8Array(32).fill(0x5e) },
  maybe: { is_some: true, value: 99n },
};

/** Boundary values for {@link BOUNDED}: max small (999), last variant index. */
export const boundedValue = { small: 999n, unit: 0n, status: 2, marker: 0xaan };

/** Value for {@link ZERO_SIZES}: only the marker occupies space. */
export const zeroSizesValue = {
  empty: new Uint8Array(0),
  none: [] as bigint[],
  nothing: {},
  marker: 0x5an,
};

/** Value for {@link TUPLE}. */
export const tupleValue: [boolean, bigint, Uint8Array] = [true, 0x1234n, Uint8Array.of(1, 2, 3, 4)];

/** Value for {@link TUPLE_PAIR}. */
export const tuplePairValue: [{ a: bigint; b: bigint }, boolean] = [{ a: 4242n, b: 7n }, true];

/**
 * Value for {@link EITHER} with BOTH arms populated at once: legal bytes, and
 * the layout must be tag-independent.
 */
export const eitherBothArms = {
  is_left: true,
  left: 4242n,
  right: new Uint8Array(32).fill(0xab),
};

/**
 * Every supported shape with a representative value: driven through the twin
 * roundtrip, the toBinaryRepr oracle, and (in the corpus) the fixture
 * circuits.
 */
export const SHAPES: [string, CompactType, CompactValue][] = [
  ['Primitives', PRIMITIVES, primitivesValue],
  ['Buffers', BUFFERS, buffersValue],
  ['VectorsPlain', VECTORS_PLAIN, vectorsPlainValue],
  ['VectorsDeep (no circuit serialize exists)', VECTORS_DEEP, vectorsDeepValue],
  ['Inner', INNER, innerValue],
  ['Inner with a false boolean', INNER, innerFalseValue],
  ['Nested (no circuit serialize exists)', NESTED, nestedValue],
  ['WithStdlib', WITH_STDLIB, stdlibValue],
  ['Bounded', BOUNDED, boundedValue],
  ['ZeroSizes', ZERO_SIZES, zeroSizesValue],
  ['tuple', TUPLE, tupleValue],
  ['tuple with struct', TUPLE_PAIR, tuplePairValue],
  ['Uint<12> (non-byte-aligned)', U12, 4095n],
  ['Uint<0..70000> (3 bytes)', WIDE, 69999n],
  ['single-variant enum (zero-width)', SOLO, 0],
  ['empty tuple (zero-width)', EMPTY_TUPLE, []],
  ['300-variant enum (2 bytes)', BIG, 299],
  ['Either with BOTH arms populated', EITHER, eitherBothArms],
  ['Maybe none (zero-filled value arm)', MAYBE_U64, { is_some: false, value: 0n }],
];
