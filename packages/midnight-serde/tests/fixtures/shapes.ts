// Twin descriptors and sample values mirroring serde-fixtures.compact, the
// shared arrange step of serde.test.ts (circuit pins) and borsh.test.ts
// (borsh pins). Each descriptor is declared `as const satisfies CompactType`
// so CompactValueOf infers exact value types at every call site.

import { type CompactType, FIELD_MODULUS } from "../../src/index.ts";

export const PAIR = {
  kind: "struct",
  fields: [
    { name: "a", type: { kind: "uint", bits: 128 } },
    { name: "b", type: { kind: "uint", bits: 64 } },
  ],
} as const satisfies CompactType;

export const PRIMITIVES = {
  kind: "struct",
  fields: [
    { name: "flag", type: { kind: "boolean" } },
    { name: "u8", type: { kind: "uint", bits: 8 } },
    { name: "u64", type: { kind: "uint", bits: 64 } },
    { name: "u128", type: { kind: "uint", bits: 128 } },
    { name: "u248", type: { kind: "uint", bits: 248 } },
    { name: "f", type: { kind: "field" } },
  ],
} as const satisfies CompactType;

export const BUFFERS = {
  kind: "struct",
  fields: [
    { name: "one", type: { kind: "bytes", length: 1 } },
    { name: "addr20", type: { kind: "bytes", length: 20 } },
    { name: "word", type: { kind: "bytes", length: 32 } },
  ],
} as const satisfies CompactType;

export const VECTORS_PLAIN = {
  kind: "struct",
  fields: [
    { name: "nums", type: { kind: "vector", length: 3, element: { kind: "uint", bits: 64 } } },
    { name: "more", type: { kind: "vector", length: 2, element: { kind: "uint", bits: 128 } } },
  ],
} as const satisfies CompactType;

export const VECTORS_DEEP = {
  kind: "struct",
  fields: [
    { name: "pairs", type: { kind: "vector", length: 2, element: PAIR } },
    {
      name: "matrix",
      type: {
        kind: "vector",
        length: 2,
        element: { kind: "vector", length: 2, element: { kind: "uint", bits: 8 } },
      },
    },
  ],
} as const satisfies CompactType;

export const INNER = {
  kind: "struct",
  fields: [
    { name: "pair", type: PAIR },
    { name: "ok", type: { kind: "boolean" } },
  ],
} as const satisfies CompactType;

export const NESTED = {
  kind: "struct",
  fields: [
    { name: "pair", type: PAIR },
    { name: "inner", type: INNER },
    { name: "ok", type: { kind: "boolean" } },
  ],
} as const satisfies CompactType;

// ContractAddress is stdlib `struct { bytes: Bytes<32> }`; Maybe<Uint<64>> is
// stdlib `struct { is_some: Boolean; value: Uint<64> }`.
export const WITH_STDLIB = {
  kind: "struct",
  fields: [
    {
      name: "owner",
      type: { kind: "struct", fields: [{ name: "bytes", type: { kind: "bytes", length: 32 } }] },
    },
    {
      name: "maybe",
      type: {
        kind: "struct",
        fields: [
          { name: "is_some", type: { kind: "boolean" } },
          { name: "value", type: { kind: "uint", bits: 64 } },
        ],
      },
    },
  ],
} as const satisfies CompactType;

// The Uint<0..n> upper bound is EXCLUSIVE (language reference): Uint<0..1000>
// holds 0..999 in 2 bytes, Uint<0..1> holds only 0 in ZERO bytes, and a
// 3-variant enum is Uint<0..3> in 1 byte.
export const BOUNDED = {
  kind: "struct",
  fields: [
    { name: "small", type: { kind: "uint", bound: 1000 } },
    { name: "unit", type: { kind: "uint", bound: 1 } },
    { name: "status", type: { kind: "enum", variants: 3 } },
    { name: "marker", type: { kind: "uint", bits: 8 } },
  ],
} as const satisfies CompactType;

export const ZERO_SIZES = {
  kind: "struct",
  fields: [
    { name: "empty", type: { kind: "bytes", length: 0 } },
    { name: "none", type: { kind: "vector", length: 0, element: { kind: "uint", bits: 64 } } },
    { name: "nothing", type: { kind: "struct", fields: [] } },
    { name: "marker", type: { kind: "uint", bits: 8 } },
  ],
} as const satisfies CompactType;

export const TUPLE = {
  kind: "tuple",
  elements: [{ kind: "boolean" }, { kind: "uint", bits: 16 }, { kind: "bytes", length: 4 }],
} as const satisfies CompactType;

export const TUPLE_PAIR = {
  kind: "tuple",
  elements: [PAIR, { kind: "boolean" }],
} as const satisfies CompactType;

// Width edge cases with their own fixture circuits: a NON-BYTE-ALIGNED sized
// uint (2 bytes, decode-rejected at 4096), a 3-byte bounded uint, the
// zero-width single-variant enum and empty tuple, and a TWO-byte enum.
export const U12 = { kind: "uint", bits: 12 } as const satisfies CompactType;
export const WIDE = { kind: "uint", bound: 70000 } as const satisfies CompactType;
export const SOLO = { kind: "enum", variants: 1 } as const satisfies CompactType;
export const EMPTY_TUPLE = { kind: "tuple", elements: [] } as const satisfies CompactType;
export const BIG = { kind: "enum", variants: 300 } as const satisfies CompactType;

// Stdlib Either<Uint<64>, Bytes<32>> is
// struct { is_left: Boolean; left: A; right: B }: BOTH arms always occupy
// their full width regardless of the tag. Maybe<T> likewise always packs
// `value`. Pinned including the constructors (left/right/some/none), which
// zero-fill the unused arm.
export const EITHER = {
  kind: "struct",
  fields: [
    { name: "is_left", type: { kind: "boolean" } },
    { name: "left", type: { kind: "uint", bits: 64 } },
    { name: "right", type: { kind: "bytes", length: 32 } },
  ],
} as const satisfies CompactType;

export const MAYBE_U64 = {
  kind: "struct",
  fields: [
    { name: "is_some", type: { kind: "boolean" } },
    { name: "value", type: { kind: "uint", bits: 64 } },
  ],
} as const satisfies CompactType;

// ---- fixture values --------------------------------------------------------

export const primitivesValue = {
  flag: true,
  u8: 255n,
  u64: (1n << 64n) - 1n,
  u128: 123456789n,
  u248: (1n << 248n) - 1n,
  f: FIELD_MODULUS - 1n,
};

export const buffersValue = {
  one: Uint8Array.of(0x7f),
  addr20: new Uint8Array(20).fill(0x11),
  word: new Uint8Array(32).fill(0xab),
};

export const vectorsPlainValue = {
  nums: [1n, 2n, 3n],
  more: [(1n << 128n) - 1n, 0n],
};

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

export const innerValue = { pair: { a: 4242n, b: 7n }, ok: true };

// Every other ser fixture value carries `true`, so this one pins the circuit
// serializing a FALSE boolean (0x00).
export const innerFalseValue = { pair: { a: 4242n, b: 7n }, ok: false };

export const nestedValue = {
  pair: { a: 1n, b: 2n },
  inner: { pair: { a: 3n, b: 4n }, ok: false },
  ok: true,
};

export const stdlibValue = {
  owner: { bytes: new Uint8Array(32).fill(0x5e) },
  maybe: { is_some: true, value: 99n },
};

export const boundedValue = { small: 999n, unit: 0n, status: 2, marker: 0xaan };

export const zeroSizesValue = {
  empty: new Uint8Array(0),
  none: [] as bigint[],
  nothing: {},
  marker: 0x5an,
};

export const tupleValue: [boolean, bigint, Uint8Array] = [true, 0x1234n, Uint8Array.of(1, 2, 3, 4)];

export const tuplePairValue: [{ a: bigint; b: bigint }, boolean] = [{ a: 4242n, b: 7n }, true];

// Both arms carry data at once: legal bytes, and the layout must be
// tag-independent.
export const eitherBothArms = {
  is_left: true,
  left: 4242n,
  right: new Uint8Array(32).fill(0xab),
};
