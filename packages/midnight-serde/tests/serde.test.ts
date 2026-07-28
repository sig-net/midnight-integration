// The package's reason to exist: every claim the TypeScript twin makes is
// pinned here against the COMPILED fixture circuits (tests/fixtures/), which
// wrap the builtin serialize<T, N> / deserialize<T, N> pair. Run
// `yarn compile` in this package first: the tests import the generated
// bindings.
//
// Coverage per fixture struct:
//   - twin encode === circuit serialize, byte for byte (boundary values incl.)
//   - circuit deserialize accepts twin-encoded bytes and returns the values
//   - twin decode of circuit-serialized bytes returns the original values
//   - the deserialize-only shapes (VectorsDeep, Nested) prove the twin can
//     encode layouts circuits can READ even where compactc cannot re-serialize
//     them in-circuit (see the bug notes in serde-fixtures.compact)
//   - circuit REJECTIONS are pinned too: out-of-range bounded uint, sized
//     uint, enum and Field encodings throw in-circuit exactly where the twin
//     throws
//   - BOTH divergences from the circuit (padding, booleans) are pinned with
//     bytes the CIRCUIT actually sees, and both opt-outs are pinned to match
//     the circuit byte for byte
//   - a second oracle: @midnight-ntwrk/compact-runtime's toBinaryRepr must
//     agree with the twin on every shape, INCLUDING the shapes compactc
//     cannot compile serialize for (tests/helpers.ts computes the oracle's
//     widths independently of the twin so width bugs cannot cancel out)
//   - tests/property.test.ts adds seeded randomised roundtrip and oracle
//     coverage on top of the hand-picked shapes here

import vm from 'node:vm';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { pureCircuits } from './fixtures/managed/contract/index.js';
import { hex, oracleSerialize } from './helpers.ts';
import {
  assertCompactType,
  compactDeserialize,
  compactSerialize,
  compactSerializedSize,
  FIELD_MODULUS,
  isCompactType,
  type CompactType,
  type CompactValue,
} from '../src/index.ts';

// ---- descriptors mirroring tests/fixtures/serde-fixtures.compact ----------

const PAIR = {
  kind: 'struct',
  fields: [
    { name: 'a', type: { kind: 'uint', bits: 128 } },
    { name: 'b', type: { kind: 'uint', bits: 64 } },
  ],
} as const satisfies CompactType;

const PRIMITIVES = {
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

const BUFFERS = {
  kind: 'struct',
  fields: [
    { name: 'one', type: { kind: 'bytes', length: 1 } },
    { name: 'addr20', type: { kind: 'bytes', length: 20 } },
    { name: 'word', type: { kind: 'bytes', length: 32 } },
  ],
} as const satisfies CompactType;

const VECTORS_PLAIN = {
  kind: 'struct',
  fields: [
    { name: 'nums', type: { kind: 'vector', length: 3, element: { kind: 'uint', bits: 64 } } },
    { name: 'more', type: { kind: 'vector', length: 2, element: { kind: 'uint', bits: 128 } } },
  ],
} as const satisfies CompactType;

const VECTORS_DEEP = {
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

const INNER = {
  kind: 'struct',
  fields: [
    { name: 'pair', type: PAIR },
    { name: 'ok', type: { kind: 'boolean' } },
  ],
} as const satisfies CompactType;

const NESTED = {
  kind: 'struct',
  fields: [
    { name: 'pair', type: PAIR },
    { name: 'inner', type: INNER },
    { name: 'ok', type: { kind: 'boolean' } },
  ],
} as const satisfies CompactType;

// ContractAddress is stdlib `struct { bytes: Bytes<32> }`; Maybe<Uint<64>> is
// stdlib `struct { is_some: Boolean; value: Uint<64> }`.
const WITH_STDLIB = {
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

// The Uint<0..n> upper bound is EXCLUSIVE (language reference): Uint<0..1000>
// holds 0..999 in 2 bytes, Uint<0..1> holds only 0 in ZERO bytes, and a
// 3-variant enum is Uint<0..3> in 1 byte.
const BOUNDED = {
  kind: 'struct',
  fields: [
    { name: 'small', type: { kind: 'uint', bound: 1000 } },
    { name: 'unit', type: { kind: 'uint', bound: 1 } },
    { name: 'status', type: { kind: 'enum', variants: 3 } },
    { name: 'marker', type: { kind: 'uint', bits: 8 } },
  ],
} as const satisfies CompactType;

const ZERO_SIZES = {
  kind: 'struct',
  fields: [
    { name: 'empty', type: { kind: 'bytes', length: 0 } },
    { name: 'none', type: { kind: 'vector', length: 0, element: { kind: 'uint', bits: 64 } } },
    { name: 'nothing', type: { kind: 'struct', fields: [] } },
    { name: 'marker', type: { kind: 'uint', bits: 8 } },
  ],
} as const satisfies CompactType;

const TUPLE = {
  kind: 'tuple',
  elements: [
    { kind: 'boolean' },
    { kind: 'uint', bits: 16 },
    { kind: 'bytes', length: 4 },
  ],
} as const satisfies CompactType;

const TUPLE_PAIR = {
  kind: 'tuple',
  elements: [PAIR, { kind: 'boolean' }],
} as const satisfies CompactType;

// Width edge cases with their own fixture circuits: a NON-BYTE-ALIGNED sized
// uint (2 bytes, decode-rejected at 4096), a 3-byte bounded uint, the
// zero-width single-variant enum and empty tuple, and a TWO-byte enum.
const U12 = { kind: 'uint', bits: 12 } as const satisfies CompactType;
const WIDE = { kind: 'uint', bound: 70000 } as const satisfies CompactType;
const SOLO = { kind: 'enum', variants: 1 } as const satisfies CompactType;
const EMPTY_TUPLE = { kind: 'tuple', elements: [] } as const satisfies CompactType;
const BIG = { kind: 'enum', variants: 300 } as const satisfies CompactType;

// Stdlib Either<Uint<64>, Bytes<32>> is
// struct { is_left: Boolean; left: A; right: B }: BOTH arms always occupy
// their full width regardless of the tag. Maybe<T> likewise always packs
// `value`. Pinned including the constructors (left/right/some/none), which
// zero-fill the unused arm.
const EITHER = {
  kind: 'struct',
  fields: [
    { name: 'is_left', type: { kind: 'boolean' } },
    { name: 'left', type: { kind: 'uint', bits: 64 } },
    { name: 'right', type: { kind: 'bytes', length: 32 } },
  ],
} as const satisfies CompactType;

const MAYBE_U64 = {
  kind: 'struct',
  fields: [
    { name: 'is_some', type: { kind: 'boolean' } },
    { name: 'value', type: { kind: 'uint', bits: 64 } },
  ],
} as const satisfies CompactType;

// ---- fixture values --------------------------------------------------------

const primitivesValue = {
  flag: true,
  u8: 255n,
  u64: (1n << 64n) - 1n,
  u128: 123456789n,
  u248: (1n << 248n) - 1n,
  f: FIELD_MODULUS - 1n,
};

const buffersValue = {
  one: Uint8Array.of(0x7f),
  addr20: new Uint8Array(20).fill(0x11),
  word: new Uint8Array(32).fill(0xab),
};

const vectorsPlainValue = {
  nums: [1n, 2n, 3n],
  more: [(1n << 128n) - 1n, 0n],
};

const vectorsDeepValue = {
  pairs: [
    { a: 4242n, b: 7n },
    { a: 0n, b: (1n << 64n) - 1n },
  ],
  matrix: [
    [1n, 2n],
    [3n, 4n],
  ],
};

const innerValue = { pair: { a: 4242n, b: 7n }, ok: true };

// Every other ser fixture value carries `true`, so this one pins the circuit
// serializing a FALSE boolean (0x00).
const innerFalseValue = { pair: { a: 4242n, b: 7n }, ok: false };

const nestedValue = {
  pair: { a: 1n, b: 2n },
  inner: { pair: { a: 3n, b: 4n }, ok: false },
  ok: true,
};

const stdlibValue = {
  owner: { bytes: new Uint8Array(32).fill(0x5e) },
  maybe: { is_some: true, value: 99n },
};

const boundedValue = { small: 999n, unit: 0n, status: 2, marker: 0xaan };

const zeroSizesValue = {
  empty: new Uint8Array(0),
  none: [] as bigint[],
  nothing: {},
  marker: 0x5an,
};

const tupleValue: [boolean, bigint, Uint8Array] = [true, 0x1234n, Uint8Array.of(1, 2, 3, 4)];

const tuplePairValue: [{ a: bigint; b: bigint }, boolean] = [{ a: 4242n, b: 7n }, true];

// Both arms carry data at once: legal bytes, and the layout must be
// tag-independent.
const eitherBothArms = {
  is_left: true,
  left: 4242n,
  right: new Uint8Array(32).fill(0xab),
};

// Every supported shape with a representative value: driven through the twin
// encode/decode roundtrip AND the toBinaryRepr oracle below.
const SHAPES: [string, CompactType, CompactValue][] = [
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

// ---- type inference --------------------------------------------------------

describe('CompactValueOf infers value types from literal descriptors', () => {
  it('deserialize returns a fully typed value, no cast needed', () => {
    const decoded = compactDeserialize(PAIR, new Uint8Array(24));
    expectTypeOf(decoded).toEqualTypeOf<{ a: bigint; b: bigint }>();
    expect(decoded).toEqual({ a: 0n, b: 0n });

    expectTypeOf(compactDeserialize(INNER, new Uint8Array(25))).toEqualTypeOf<{
      pair: { a: bigint; b: bigint };
      ok: boolean;
    }>();
    expectTypeOf(compactDeserialize(VECTORS_PLAIN, new Uint8Array(56))).toEqualTypeOf<{
      nums: bigint[];
      more: bigint[];
    }>();
  });

  it('tuples type as TS tuples, enums as numbers', () => {
    expectTypeOf(compactDeserialize(TUPLE, new Uint8Array(7))).toEqualTypeOf<
      [boolean, bigint, Uint8Array]
    >();
    expectTypeOf(compactDeserialize(BOUNDED, new Uint8Array(4))).toEqualTypeOf<{
      small: bigint;
      unit: bigint;
      status: number;
      marker: bigint;
    }>();
    expectTypeOf(compactDeserialize(U12, new Uint8Array(2))).toEqualTypeOf<bigint>();
    expectTypeOf(compactDeserialize(BIG, new Uint8Array(2))).toEqualTypeOf<number>();
    expectTypeOf(compactDeserialize(EMPTY_TUPLE, new Uint8Array(0))).toEqualTypeOf<[]>();
  });
});

// ---- packed sizes ----------------------------------------------------------

describe('compactSerializedSize matches the compiler', () => {
  it('pins every fixture size', () => {
    expect(compactSerializedSize(PRIMITIVES)).toBe(89);
    expect(compactSerializedSize(BUFFERS)).toBe(53);
    expect(compactSerializedSize(VECTORS_PLAIN)).toBe(56);
    expect(compactSerializedSize(VECTORS_DEEP)).toBe(52);
    expect(compactSerializedSize(INNER)).toBe(25);
    expect(compactSerializedSize(NESTED)).toBe(50);
    expect(compactSerializedSize(WITH_STDLIB)).toBe(41);
    expect(compactSerializedSize(BOUNDED)).toBe(4);
    expect(compactSerializedSize(ZERO_SIZES)).toBe(1);
    expect(compactSerializedSize(TUPLE)).toBe(7);
    expect(compactSerializedSize(TUPLE_PAIR)).toBe(25);
    expect(compactSerializedSize(U12)).toBe(2);
    expect(compactSerializedSize(WIDE)).toBe(3);
    expect(compactSerializedSize(SOLO)).toBe(0);
    expect(compactSerializedSize(EMPTY_TUPLE)).toBe(0);
    expect(compactSerializedSize(BIG)).toBe(2);
    expect(compactSerializedSize(EITHER)).toBe(41);
    expect(compactSerializedSize(MAYBE_U64)).toBe(9);
  });

  it('zero-size shapes really are zero bytes', () => {
    expect(compactSerializedSize({ kind: 'uint', bound: 1 })).toBe(0);
    expect(compactSerializedSize({ kind: 'enum', variants: 1 })).toBe(0);
    expect(compactSerializedSize({ kind: 'bytes', length: 0 })).toBe(0);
    expect(compactSerializedSize({ kind: 'tuple', elements: [] })).toBe(0);
    expect(compactSerializedSize({ kind: 'struct', fields: [] })).toBe(0);
    expect(
      compactSerializedSize({ kind: 'vector', length: 0, element: { kind: 'field' } })
    ).toBe(0);
  });

  it('bounded widths follow byteLength(bound - 1)', () => {
    expect(compactSerializedSize({ kind: 'uint', bound: 2 })).toBe(1);
    expect(compactSerializedSize({ kind: 'uint', bound: 256 })).toBe(1);
    expect(compactSerializedSize({ kind: 'uint', bound: 257 })).toBe(2);
    expect(compactSerializedSize({ kind: 'uint', bound: 1n << 248n })).toBe(31);
    expect(compactSerializedSize({ kind: 'enum', variants: 256 })).toBe(1);
    expect(compactSerializedSize({ kind: 'enum', variants: 257 })).toBe(2);
  });
});

// ---- twin encode === circuit serialize -------------------------------------

describe('compactSerialize equals the compiled circuits byte for byte', () => {
  it('Primitives (exact N, boundary values)', () => {
    expect(hex(compactSerialize(PRIMITIVES, primitivesValue, 89))).toBe(
      hex(pureCircuits.serPrimitives(primitivesValue))
    );
  });

  it('Buffers (padded N pins right zero-padding)', () => {
    expect(hex(compactSerialize(BUFFERS, buffersValue, 64))).toBe(
      hex(pureCircuits.serBuffers(buffersValue))
    );
  });

  it('VectorsPlain', () => {
    expect(hex(compactSerialize(VECTORS_PLAIN, vectorsPlainValue, 56))).toBe(
      hex(pureCircuits.serVectorsPlain(vectorsPlainValue))
    );
  });

  it('Inner (one nesting level)', () => {
    expect(hex(compactSerialize(INNER, innerValue, 25))).toBe(
      hex(pureCircuits.serInner(innerValue))
    );
  });

  it('Inner with a FALSE boolean (0x00)', () => {
    const bytes = pureCircuits.serInner(innerFalseValue);
    expect(bytes[24]).toBe(0);
    expect(hex(compactSerialize(INNER, innerFalseValue, 25))).toBe(hex(bytes));
  });

  it('WithStdlib (ContractAddress + Maybe<Uint<64>>)', () => {
    expect(hex(compactSerialize(WITH_STDLIB, stdlibValue, 41))).toBe(
      hex(pureCircuits.serStdlib(stdlibValue))
    );
  });

  it('Bounded (bounded uints, zero-width Uint<0..1>, enum; padded N)', () => {
    expect(hex(compactSerialize(BOUNDED, boundedValue, 8))).toBe(
      hex(pureCircuits.serBounded(boundedValue))
    );
  });

  it('ZeroSizes (Bytes<0>, Vector<0, T>, empty struct)', () => {
    expect(hex(compactSerialize(ZERO_SIZES, zeroSizesValue, 1))).toBe(
      hex(pureCircuits.serZeroSizes(zeroSizesValue))
    );
  });

  it('heterogeneous tuple', () => {
    expect(hex(compactSerialize(TUPLE, tupleValue, 7))).toBe(
      hex(pureCircuits.serTuple(tupleValue))
    );
  });

  it('tuple containing a struct (compiles, unlike Vector<n, Struct>)', () => {
    expect(hex(compactSerialize(TUPLE_PAIR, tuplePairValue, 25))).toBe(
      hex(pureCircuits.serTuplePair(tuplePairValue))
    );
  });

  it('Uint<12>: non-byte-aligned width packs to ceil(12/8) = 2 bytes LE', () => {
    expect(hex(compactSerialize(U12, 4095n, 2))).toBe(hex(pureCircuits.serU12(4095n)));
    expect(hex(pureCircuits.serU12(4095n))).toBe('ff0f');
    expect(hex(compactSerialize(U12, 0n, 2))).toBe(hex(pureCircuits.serU12(0n)));
  });

  it('Uint<0..70000>: 3-byte bounded width (byteLength(69999))', () => {
    expect(hex(compactSerialize(WIDE, 69999n, 3))).toBe(hex(pureCircuits.serWide(69999n)));
    expect(hex(pureCircuits.serWide(69999n))).toBe('6f1101');
  });

  it('single-variant enum: ZERO bytes, so Bytes<1> is pure padding', () => {
    expect(hex(compactSerialize(SOLO, 0, 1))).toBe(hex(pureCircuits.serSolo(0)));
    expect(hex(pureCircuits.serSolo(0))).toBe('00');
  });

  it('empty tuple: ZERO bytes, so Bytes<1> is pure padding', () => {
    expect(hex(compactSerialize(EMPTY_TUPLE, [], 1))).toBe(hex(pureCircuits.serEmptyTuple([])));
    expect(hex(pureCircuits.serEmptyTuple([]))).toBe('00');
  });

  it('300-variant enum: the index packs like Uint<0..300>, 2 bytes LE', () => {
    expect(hex(compactSerialize(BIG, 299, 2))).toBe(hex(pureCircuits.serBig(299)));
    expect(hex(pureCircuits.serBig(299))).toBe('2b01');
    expect(hex(compactSerialize(BIG, 0, 2))).toBe(hex(pureCircuits.serBig(0)));
  });
});

// ---- circuit deserialize accepts twin bytes --------------------------------

describe('circuit deserialize accepts compactSerialize output', () => {
  it('Primitives', () => {
    expect(pureCircuits.dePrimitives(compactSerialize(PRIMITIVES, primitivesValue, 89))).toEqual(
      primitivesValue
    );
  });

  it('Buffers', () => {
    const decoded = pureCircuits.deBuffers(compactSerialize(BUFFERS, buffersValue, 64));
    expect(hex(decoded.one)).toBe(hex(buffersValue.one));
    expect(hex(decoded.addr20)).toBe(hex(buffersValue.addr20));
    expect(hex(decoded.word)).toBe(hex(buffersValue.word));
  });

  it('VectorsPlain', () => {
    expect(
      pureCircuits.deVectorsPlain(compactSerialize(VECTORS_PLAIN, vectorsPlainValue, 56))
    ).toEqual(vectorsPlainValue);
  });

  it('VectorsDeep: circuits can READ shapes compactc cannot re-serialize', () => {
    expect(
      pureCircuits.deVectorsDeep(compactSerialize(VECTORS_DEEP, vectorsDeepValue, 52))
    ).toEqual(vectorsDeepValue);
  });

  it('Inner', () => {
    expect(pureCircuits.deInner(compactSerialize(INNER, innerValue, 25))).toEqual(innerValue);
  });

  it('Nested (two nesting levels): deserialize-only shape, padded to 128', () => {
    expect(pureCircuits.deNested(compactSerialize(NESTED, nestedValue, 128))).toEqual(nestedValue);
  });

  it('WithStdlib', () => {
    const decoded = pureCircuits.deStdlib(compactSerialize(WITH_STDLIB, stdlibValue, 41));
    expect(hex(decoded.owner.bytes)).toBe(hex(stdlibValue.owner.bytes));
    expect(decoded.maybe).toEqual(stdlibValue.maybe);
  });

  it('Bounded', () => {
    expect(pureCircuits.deBounded(compactSerialize(BOUNDED, boundedValue, 8))).toEqual(
      boundedValue
    );
  });

  it('ZeroSizes', () => {
    const decoded = pureCircuits.deZeroSizes(compactSerialize(ZERO_SIZES, zeroSizesValue, 1));
    expect(decoded.marker).toBe(zeroSizesValue.marker);
    expect(decoded.empty).toHaveLength(0);
    expect(decoded.none).toEqual([]);
  });

  it('tuples', () => {
    expect(pureCircuits.deTuple(compactSerialize(TUPLE, tupleValue, 7))).toEqual(tupleValue);
    expect(pureCircuits.deTuplePair(compactSerialize(TUPLE_PAIR, tuplePairValue, 25))).toEqual(
      tuplePairValue
    );
  });

  it('width edge cases (U12, Wide, Solo, empty tuple, Big)', () => {
    expect(pureCircuits.deU12(compactSerialize(U12, 4095n, 2))).toBe(4095n);
    expect(pureCircuits.deWide(compactSerialize(WIDE, 69999n, 3))).toBe(69999n);
    expect(pureCircuits.deSolo(compactSerialize(SOLO, 0, 1))).toBe(0);
    expect(pureCircuits.deEmptyTuple(compactSerialize(EMPTY_TUPLE, [], 1))).toEqual([]);
    expect(pureCircuits.deBig(compactSerialize(BIG, 299, 2))).toBe(299);
  });
});

// ---- twin decode of circuit bytes ------------------------------------------

describe('compactDeserialize inverts the compiled circuits', () => {
  it('Primitives', () => {
    expect(compactDeserialize(PRIMITIVES, pureCircuits.serPrimitives(primitivesValue))).toEqual(
      primitivesValue
    );
  });

  it('Bounded and tuples', () => {
    expect(compactDeserialize(BOUNDED, pureCircuits.serBounded(boundedValue))).toEqual(
      boundedValue
    );
    expect(compactDeserialize(TUPLE, pureCircuits.serTuple(tupleValue))).toEqual(tupleValue);
    expect(compactDeserialize(TUPLE_PAIR, pureCircuits.serTuplePair(tuplePairValue))).toEqual(
      tuplePairValue
    );
  });

  it('full circle: circuit ser → twin decode → twin encode → circuit de', () => {
    const circuitBytes = pureCircuits.serVectorsPlain(vectorsPlainValue);
    const decoded = compactDeserialize(VECTORS_PLAIN, circuitBytes);
    const reEncoded = compactSerialize(VECTORS_PLAIN, decoded, 56);
    expect(hex(reEncoded)).toBe(hex(circuitBytes));
    expect(pureCircuits.deVectorsPlain(reEncoded)).toEqual(vectorsPlainValue);
  });

  it('width edge cases (U12, Wide, Solo, empty tuple, Big)', () => {
    expect(compactDeserialize(U12, pureCircuits.serU12(4095n))).toBe(4095n);
    expect(compactDeserialize(WIDE, pureCircuits.serWide(69999n))).toBe(69999n);
    expect(compactDeserialize(SOLO, pureCircuits.serSolo(0))).toBe(0);
    expect(compactDeserialize(EMPTY_TUPLE, pureCircuits.serEmptyTuple([]))).toEqual([]);
    expect(compactDeserialize(BIG, pureCircuits.serBig(299))).toBe(299);
  });
});

// ---- twin encode → twin decode roundtrips every shape ----------------------

describe('twin roundtrip: compactDeserialize inverts compactSerialize', () => {
  for (const [name, type, value] of SHAPES) {
    it(name, () => {
      const size = compactSerializedSize(type);
      expect(compactDeserialize(type, compactSerialize(type as never, value as never))).toEqual(
        value
      );
      // Padded form roundtrips through the strict decoder too.
      expect(
        compactDeserialize(type, compactSerialize(type as never, value as never, size + 9))
      ).toEqual(value);
    });
  }
});

// ---- stdlib Maybe/Either and their constructors -----------------------------

describe('stdlib Maybe/Either serialize as plain structs, constructors zero-fill', () => {
  const zero32 = new Uint8Array(32);
  const word = new Uint8Array(32).fill(0xab);

  it('Either packs both arms regardless of the tag, twin === circuit', () => {
    expect(hex(compactSerialize(EITHER, eitherBothArms, 41))).toBe(
      hex(pureCircuits.serEither(eitherBothArms))
    );
    expect(pureCircuits.deEither(compactSerialize(EITHER, eitherBothArms, 41))).toEqual(
      eitherBothArms
    );
  });

  it('left() and right() zero-fill the unused arm, and the twin predicts the bytes', () => {
    expect(hex(pureCircuits.serLeft(4242n))).toBe(
      hex(compactSerialize(EITHER, { is_left: true, left: 4242n, right: zero32 }, 41))
    );
    expect(hex(pureCircuits.serRight(word))).toBe(
      hex(compactSerialize(EITHER, { is_left: false, left: 0n, right: word }, 41))
    );
  });

  it('some() and none() likewise', () => {
    expect(hex(pureCircuits.serSomeU64(99n))).toBe(
      hex(compactSerialize(MAYBE_U64, { is_some: true, value: 99n }, 9))
    );
    expect(hex(pureCircuits.serNoneU64())).toBe(
      hex(compactSerialize(MAYBE_U64, { is_some: false, value: 0n }, 9))
    );
  });

  it('constructor output decodes STRICTLY: the zero fill is value bytes, not padding', () => {
    expect(compactDeserialize(EITHER, pureCircuits.serLeft(4242n))).toEqual({
      is_left: true,
      left: 4242n,
      right: zero32,
    });
    expect(compactDeserialize(EITHER, pureCircuits.serRight(word))).toEqual({
      is_left: false,
      left: 0n,
      right: word,
    });
    expect(compactDeserialize(MAYBE_U64, pureCircuits.serNoneU64())).toEqual({
      is_some: false,
      value: 0n,
    });
  });
});

// ---- second oracle: compact-runtime's toBinaryRepr --------------------------

// See tests/helpers.ts: the oracle's byte widths are computed independently
// of the twin's width logic, so a width bug cannot cancel out of the
// comparison.
describe('toBinaryRepr (compact-runtime) agrees with the twin', () => {
  for (const [name, type, value] of SHAPES) {
    it(name, () => {
      expect(hex(compactSerialize(type as never, value as never))).toBe(
        hex(oracleSerialize(type, value))
      );
    });
  }
});

// ---- padding semantics -----------------------------------------------------

describe('padding', () => {
  it('twin pads right with zeros exactly like serialize<T, N>', () => {
    const padded = compactSerialize(INNER, innerValue, 128);
    const exact = compactSerialize(INNER, innerValue);
    expect(padded).toHaveLength(128);
    expect(hex(padded.slice(0, 25))).toBe(hex(exact));
    expect(padded.slice(25).every((b) => b === 0)).toBe(true);
  });

  it('circuit deserialize ignores padding garbage; the twin rejects unless told not to', () => {
    // deNested is Bytes<128> over a 50-byte packed prefix, so bytes 50..127
    // are padding the CIRCUIT itself receives: fill all of them with 0xff.
    const bytes = compactSerialize(NESTED, nestedValue, 128);
    bytes.fill(0xff, 50);
    expect(pureCircuits.deNested(bytes)).toEqual(nestedValue);
    expect(compactDeserialize(NESTED, bytes, { ignorePadding: true })).toEqual(nestedValue);
    expect(() => compactDeserialize(NESTED, bytes)).toThrow(/non-zero padding/);
  });

  it('zero-width shapes are ALL padding: the circuit ignores the whole buffer', () => {
    expect(pureCircuits.deSolo(Uint8Array.of(0xff))).toBe(0);
    expect(pureCircuits.deEmptyTuple(Uint8Array.of(0xff))).toEqual([]);
    expect(compactDeserialize(SOLO, Uint8Array.of(0xff), { ignorePadding: true })).toBe(0);
    expect(() => compactDeserialize(SOLO, Uint8Array.of(0xff))).toThrow(/non-zero padding/);
  });
});

// ---- circuit-pinned rejections and divergences ------------------------------

describe('circuit rejections are pinned, divergences documented', () => {
  it('the circuit rejects out-of-range bounded uint encodings, and so does the twin', () => {
    // small = 1000 (0x03e8) is one above the largest legal value 999.
    const bad = Uint8Array.from([0xe8, 0x03, 0x02, 0xaa, 0, 0, 0, 0]);
    expect(() => pureCircuits.deBounded(bad)).toThrow(/exceeds maximum value 999/);
    expect(() => compactDeserialize(BOUNDED, bad)).toThrow(/exceeds Uint<0\.\.1000>/);
  });

  it('the circuit rejects out-of-range enum encodings, and so does the twin', () => {
    // status = 3 in a 3-variant enum.
    const bad = Uint8Array.from([0x00, 0x00, 0x03, 0xaa, 0, 0, 0, 0]);
    expect(() => pureCircuits.deBounded(bad)).toThrow(/exceeds maximum value 2/);
    expect(() => compactDeserialize(BOUNDED, bad)).toThrow(/exceeds the last variant index 2/);
  });

  it('the circuit rejects out-of-range SIZED uint encodings (non-byte-aligned), and so does the twin', () => {
    // 0x1fff in Uint<12>: fits the 2-byte encoding, exceeds 2^12 - 1.
    const bad = Uint8Array.of(0xff, 0x1f);
    expect(() => pureCircuits.deU12(bad)).toThrow(/exceeds maximum value 4095/);
    expect(() => compactDeserialize(U12, bad)).toThrow(/exceeds Uint<12>/);
  });

  it('the circuit rejects the bound itself in a 3-byte bounded uint, and so does the twin', () => {
    // 70000 = 0x011170, one above the largest legal value 69999.
    const bad = Uint8Array.of(0x70, 0x11, 0x01);
    expect(() => pureCircuits.deWide(bad)).toThrow(/exceeds maximum value 69999/);
    expect(() => compactDeserialize(WIDE, bad)).toThrow(/exceeds Uint<0\.\.70000>/);
  });

  it('the circuit rejects index 300 in a 300-variant (2-byte) enum, and so does the twin', () => {
    const bad = Uint8Array.of(0x2c, 0x01);
    expect(() => pureCircuits.deBig(bad)).toThrow(/exceeds maximum value 299/);
    expect(() => compactDeserialize(BIG, bad)).toThrow(/exceeds the last variant index 299/);
  });

  it('the circuit rejects Field encodings at or above the modulus, and so does the twin', () => {
    const bytes = new Uint8Array(89);
    let v = FIELD_MODULUS;
    for (let i = 0; i < 32; i++) {
      bytes[57 + i] = Number(v & 0xffn);
      v >>= 8n;
    }
    expect(() => pureCircuits.dePrimitives(bytes)).toThrow();
    expect(() => compactDeserialize(PRIMITIVES, bytes)).toThrow(/Field modulus/);
  });

  it('DIVERGENCE: the circuit decodes boolean bytes above 1 as false, the twin rejects them', () => {
    for (const byte of [0x02, 0x80, 0xff]) {
      const bytes = new Uint8Array(25);
      bytes[24] = byte;
      expect(pureCircuits.deInner(bytes)).toEqual({ pair: { a: 0n, b: 0n }, ok: false });
      expect(() => compactDeserialize(INNER, bytes)).toThrow(/invalid boolean byte/);
      // lenientBooleans mirrors the circuit exactly.
      expect(compactDeserialize(INNER, bytes, { lenientBooleans: true })).toEqual(
        pureCircuits.deInner(bytes)
      );
    }
  });

  it('lenientBooleans still decodes 0x00/0x01 normally', () => {
    const bytes = new Uint8Array(25);
    bytes[24] = 1;
    expect(compactDeserialize(INNER, bytes, { lenientBooleans: true })).toEqual({
      pair: { a: 0n, b: 0n },
      ok: true,
    });
    bytes[24] = 0;
    expect(compactDeserialize(INNER, bytes, { lenientBooleans: true })).toEqual({
      pair: { a: 0n, b: 0n },
      ok: false,
    });
  });

  it('circuit-exact mode: ignorePadding + lenientBooleans matches the circuit on hostile bytes', () => {
    const bytes = compactSerialize(NESTED, nestedValue, 128);
    bytes.fill(0xff, 50);
    bytes[49] = 0x7f; // Nested.ok, decoded false by the circuit
    expect(
      compactDeserialize(NESTED, bytes, { ignorePadding: true, lenientBooleans: true })
    ).toEqual(pureCircuits.deNested(bytes));
  });
});

// ---- twin rejections -------------------------------------------------------

describe('twin rejections', () => {
  it('out-of-range and negative numerics', () => {
    const U8 = {
      kind: 'struct',
      fields: [{ name: 'v', type: { kind: 'uint', bits: 8 } }],
    } as const satisfies CompactType;
    expect(() => compactSerialize(U8, { v: 256n })).toThrow(/exceeds Uint<8>/);
    expect(() => compactSerialize(U8, { v: -1n })).toThrow(/negative/);
    const F = {
      kind: 'struct',
      fields: [{ name: 'v', type: { kind: 'field' } }],
    } as const satisfies CompactType;
    expect(() => compactSerialize(F, { v: FIELD_MODULUS })).toThrow(/Field modulus/);
  });

  it('bounded uint and enum ranges on encode', () => {
    expect(() => compactSerialize({ kind: 'uint', bound: 1000 }, 1000n)).toThrow(
      /exceeds Uint<0\.\.1000>/
    );
    expect(() => compactSerialize({ kind: 'uint', bound: 1 }, 1n)).toThrow(
      /exceeds Uint<0\.\.1>/
    );
    expect(() => compactSerialize({ kind: 'enum', variants: 3 }, 3)).toThrow(
      /outside 0\.\.2/
    );
    expect(() => compactSerialize({ kind: 'enum', variants: 3 }, -1)).toThrow(
      /outside 0\.\.2/
    );
    expect(() => compactSerialize({ kind: 'enum', variants: 3 }, 1n as never)).toThrow(
      /expected an integer number/
    );
  });

  it('structural mismatches', () => {
    // A missing field is a COMPILE error with a literal descriptor now
    // (CompactValueOf types the value), so the runtime check needs a cast.
    expect(() => compactSerialize(INNER, { pair: { a: 1n, b: 2n } } as never)).toThrow(
      /missing field 'ok'/
    );
    expect(() =>
      compactSerialize(BUFFERS, { ...buffersValue, word: new Uint8Array(31) })
    ).toThrow(/exactly 32 bytes/);
    expect(() =>
      compactSerialize(VECTORS_PLAIN, { ...vectorsPlainValue, nums: [1n] })
    ).toThrow(/exactly 3 elements/);
    expect(() => compactSerialize(TUPLE, [true, 0x1234n] as never)).toThrow(
      /exactly 3 elements/
    );
  });

  it('padTo below the packed size (a compile error in Compact too)', () => {
    expect(() => compactSerialize(INNER, innerValue, 8)).toThrow(/below the packed size/);
  });

  it('out-of-range Field encodings on decode (the circuit rejects them too)', () => {
    const F = {
      kind: 'struct',
      fields: [{ name: 'v', type: { kind: 'field' } }],
    } as const satisfies CompactType;
    const bad = new Uint8Array(32).fill(0xff);
    expect(() => compactDeserialize(F, bad)).toThrow(/Field modulus/);
  });

  it('out-of-range encodings of non-byte-aligned uints on decode', () => {
    const U4 = {
      kind: 'struct',
      fields: [{ name: 'v', type: { kind: 'uint', bits: 4 } }],
    } as const satisfies CompactType;
    expect(compactDeserialize(U4, Uint8Array.of(0x0f))).toEqual({ v: 15n });
    expect(() => compactDeserialize(U4, Uint8Array.of(0x1f))).toThrow(/exceeds Uint<4>/);
  });

  it('a buffer shorter than the packed size throws, never a partial decode', () => {
    expect(() => compactDeserialize(PAIR, new Uint8Array(10))).toThrow(
      /needs 24 bytes, buffer has 10/
    );
    expect(() => compactDeserialize(PRIMITIVES, new Uint8Array(0))).toThrow(
      /needs 89 bytes, buffer has 0/
    );
  });

  it('unknown struct fields are rejected on encode, mirroring descriptor strictness', () => {
    expect(() => compactSerialize(PAIR, { a: 1n, b: 2n, c: 3n } as never)).toThrow(
      /unknown field 'c'/
    );
    // The dangerous shape: the typo'd key ALONGSIDE the correct ones would
    // previously vanish silently.
    expect(() =>
      compactSerialize(INNER, { ...innerValue, oK: false } as never)
    ).toThrow(/unknown field 'oK'/);
  });
});

// ---- resource-exhaustion guards --------------------------------------------

describe('hostile descriptors cannot hang or mis-size the codec', () => {
  it('a huge vector of ZERO-WIDTH elements is refused on decode (it needs no input at all)', () => {
    const bomb = {
      kind: 'vector',
      length: 1e15,
      element: { kind: 'struct', fields: [] },
    } as const satisfies CompactType;
    expect(() => compactDeserialize(bomb, new Uint8Array(0))).toThrow(/zero-width/);
    // Nesting cannot dodge the cap: the budget is cumulative across the tree.
    const nestedBomb = {
      kind: 'vector',
      length: 60000,
      element: {
        kind: 'vector',
        length: 60000,
        element: { kind: 'tuple', elements: [] },
      },
    } as const satisfies CompactType;
    expect(() => compactDeserialize(nestedBomb, new Uint8Array(0))).toThrow(/zero-width/);
  });

  it('reasonable zero-width vectors still decode fine', () => {
    const ok = {
      kind: 'vector',
      length: 3,
      element: { kind: 'tuple', elements: [] },
    } as const satisfies CompactType;
    expect(compactDeserialize(ok, new Uint8Array(0))).toEqual([[], [], []]);
  });

  it('packed sizes that leave the safe-integer range throw instead of rounding', () => {
    const huge = {
      kind: 'vector',
      length: 2 ** 53 - 1,
      element: { kind: 'bytes', length: 3 },
    } as const satisfies CompactType;
    expect(() => compactSerializedSize(huge)).toThrow(/MAX_SAFE_INTEGER/);
  });
});

// ---- hostile field names ----------------------------------------------------

describe('hostile field names (legal Compact identifiers, hostile to JS)', () => {
  const PROTO = {
    kind: 'struct',
    fields: [
      { name: '__proto__', type: { kind: 'uint', bits: 8 } },
      { name: 'toString', type: { kind: 'uint', bits: 8 } },
      { name: 'y', type: { kind: 'uint', bits: 8 } },
    ],
  } as const satisfies CompactType;

  it('decode materialises them as own properties, no prototype pollution', () => {
    const decoded = compactDeserialize(PROTO, Uint8Array.of(5, 6, 7)) as Record<string, unknown>;
    expect(Object.hasOwn(decoded, '__proto__')).toBe(true);
    expect(Object.hasOwn(decoded, 'toString')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(decoded, '__proto__')?.value).toBe(5n);
    expect(decoded['toString']).toBe(6n);
    expect(decoded['y']).toBe(7n);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  });

  it('encode reads own properties only and roundtrips', () => {
    // JSON.parse creates a real own '__proto__' property (object literals
    // would not).
    const value = JSON.parse('{"__proto__": 5, "toString": 6, "y": 7}') as never;
    const patched = Object.fromEntries(
      Object.entries(value as Record<string, number>).map(([k, v]) => [k, BigInt(v)])
    );
    const bytes = compactSerialize(PROTO, patched as never);
    expect(hex(bytes)).toBe('050607');
    expect(compactDeserialize(PROTO, bytes)).toEqual(patched);
  });

  it('inherited properties do not satisfy a field: own properties only', () => {
    // In an object literal `__proto__: 5n` sets the prototype (a no-op for a
    // primitive) and creates NO own property, so the field really is missing.
    expect(() => compactSerialize(PROTO, { __proto__: 5n, y: 7n } as never)).toThrow(
      /missing field '__proto__'/
    );
    // 'toString' exists on Object.prototype for every object, but only an
    // OWN property counts.
    const noToString = JSON.parse('{"__proto__": 5, "y": 7}') as Record<string, number>;
    const patched = Object.fromEntries(
      Object.entries(noToString).map(([k, v]) => [k, BigInt(v)])
    );
    expect(() => compactSerialize(PROTO, patched as never)).toThrow(
      /missing field 'toString'/
    );
  });
});

// ---- strict descriptor validation ------------------------------------------

describe('strict runtime descriptor validation (TypeScript is not enough)', () => {
  // Everything here deliberately bypasses the compile-time types the way a
  // plain-JS caller or a bad cast would.
  const bad = (descriptor: unknown): CompactType => descriptor as CompactType;

  it('rejects unknown kinds at every entry point, never returns undefined', () => {
    const banana = bad({ kind: 'banana' });
    expect(() => compactSerializedSize(banana)).toThrow(/unknown descriptor kind "banana"/);
    expect(() => compactSerialize(banana, true as never)).toThrow(/unknown descriptor kind/);
    expect(() => compactDeserialize(banana, new Uint8Array(1))).toThrow(
      /unknown descriptor kind/
    );
  });

  it('rejects Object.prototype member names as kinds with the CLEAN error', () => {
    expect(() => compactSerializedSize(bad({ kind: 'toString' }))).toThrow(
      /unknown descriptor kind "toString"/
    );
    expect(() => compactSerializedSize(bad({ kind: 'constructor' }))).toThrow(
      /unknown descriptor kind "constructor"/
    );
  });

  it('rejects non-object descriptors', () => {
    expect(() => compactSerializedSize(bad(null))).toThrow(/plain object/);
    expect(() => compactSerializedSize(bad('uint'))).toThrow(/plain object/);
    expect(() => compactSerializedSize(bad([]))).toThrow(/plain object/);
  });

  it('rejects unexpected extra keys (typo protection)', () => {
    expect(() => compactSerializedSize(bad({ kind: 'uint', bits: 8, bytes: 1 }))).toThrow(
      /unexpected key 'bytes'/
    );
    expect(() => compactSerializedSize(bad({ kind: 'boolean', length: 1 }))).toThrow(
      /unexpected key 'length'/
    );
  });

  it('rejects out-of-range and non-integer widths and lengths', () => {
    expect(() => compactSerializedSize(bad({ kind: 'uint', bits: 0 }))).toThrow(/1\.\.248/);
    expect(() => compactSerializedSize(bad({ kind: 'uint', bits: 249 }))).toThrow(/1\.\.248/);
    expect(() => compactSerializedSize(bad({ kind: 'uint', bits: 8.5 }))).toThrow(/1\.\.248/);
    expect(() => compactSerializedSize(bad({ kind: 'bytes', length: -1 }))).toThrow(
      /non-negative safe integer/
    );
    expect(() =>
      compactSerializedSize(bad({ kind: 'vector', length: 2.5, element: { kind: 'boolean' } }))
    ).toThrow(/non-negative safe integer/);
  });

  it('rejects lengths beyond Number.MAX_SAFE_INTEGER (they break size arithmetic)', () => {
    expect(() => compactSerializedSize(bad({ kind: 'bytes', length: 2 ** 60 }))).toThrow(
      /non-negative safe integer/
    );
    expect(() =>
      compactSerializedSize(bad({ kind: 'vector', length: 2 ** 60, element: { kind: 'boolean' } }))
    ).toThrow(/non-negative safe integer/);
  });

  it('rejects uint keys inherited through the prototype chain', () => {
    // Object.keys sees no 'bits', so a naive `record.bits` read would treat
    // this as a valid Uint<8> while the key checker saw nothing wrong.
    const inherited = Object.assign(Object.create({ bits: 8 }), { kind: 'uint' });
    expect(() => compactSerializedSize(inherited as CompactType)).toThrow(/exactly one of/);
  });

  it('accepts Uint8Array values from another realm', () => {
    const foreign = vm.runInNewContext('new Uint8Array([1, 2, 3])') as Uint8Array;
    expect(foreign instanceof Uint8Array).toBe(false);
    const BYTES3 = { kind: 'bytes', length: 3 } as const satisfies CompactType;
    expect(hex(compactSerialize(BYTES3, foreign))).toBe('010203');
    expect(hex(compactDeserialize(BYTES3, foreign))).toBe('010203');
  });

  it('uint form is exactly one of bits and bound', () => {
    expect(() => compactSerializedSize(bad({ kind: 'uint' }))).toThrow(/exactly one of/);
    expect(() => compactSerializedSize(bad({ kind: 'uint', bits: 8, bound: 256 }))).toThrow(
      /exactly one of/
    );
    expect(() => compactSerializedSize(bad({ kind: 'uint', bound: 0 }))).toThrow(/1\.\.2\^248/);
    expect(() =>
      compactSerializedSize(bad({ kind: 'uint', bound: (1n << 248n) + 1n }))
    ).toThrow(/1\.\.2\^248/);
    expect(() => compactSerializedSize(bad({ kind: 'uint', bound: 2 ** 60 }))).toThrow(
      /safe integer/
    );
    expect(() => compactSerializedSize(bad({ kind: 'enum', variants: 0 }))).toThrow(
      /positive integer/
    );
    expect(() =>
      compactSerializedSize(bad({ kind: 'tuple', elements: { length: 1 } }))
    ).toThrow(/must be an array/);
  });

  it('zero-size shapes are VALID descriptors (compactc accepts them)', () => {
    expect(isCompactType({ kind: 'bytes', length: 0 })).toBe(true);
    expect(isCompactType({ kind: 'vector', length: 0, element: { kind: 'boolean' } })).toBe(true);
    expect(isCompactType({ kind: 'struct', fields: [] })).toBe(true);
    expect(isCompactType({ kind: 'tuple', elements: [] })).toBe(true);
    expect(isCompactType({ kind: 'uint', bound: 1 })).toBe(true);
    expect(isCompactType({ kind: 'enum', variants: 1 })).toBe(true);
  });

  it('rejects malformed structs with a path to the offending node', () => {
    expect(() =>
      compactSerializedSize(
        bad({ kind: 'struct', fields: [{ name: '', type: { kind: 'boolean' } }] })
      )
    ).toThrow(/fields\[0\]: field name/);
    expect(() =>
      compactSerializedSize(
        bad({
          kind: 'struct',
          fields: [
            { name: 'a', type: { kind: 'boolean' } },
            { name: 'a', type: { kind: 'boolean' } },
          ],
        })
      )
    ).toThrow(/duplicate field name 'a'/);
    expect(() =>
      compactSerializedSize(
        bad({
          kind: 'struct',
          fields: [{ name: 'a', type: { kind: 'boolean' }, maxBytes: 4 }],
        })
      )
    ).toThrow(/unexpected key 'maxBytes'/);
    // The path points at the deep node, not the root.
    expect(() =>
      compactSerializedSize(
        bad({
          kind: 'struct',
          fields: [
            {
              name: 'xs',
              type: { kind: 'vector', length: 2, element: { kind: 'uint', bits: 300 } },
            },
          ],
        })
      )
    ).toThrow(/type\.fields\[0\]\.type\.element/);
  });

  it('rejects a non-Uint8Array buffer and a fractional padTo', () => {
    expect(() => compactDeserialize(PAIR, bad([1, 2, 3]) as never)).toThrow(
      /must be a Uint8Array/
    );
    expect(() => compactSerialize(PAIR, { a: 1n, b: 2n }, 24.5)).toThrow(
      /non-negative integer/
    );
  });

  it('isCompactType mirrors the assertion', () => {
    expect(isCompactType(PAIR)).toBe(true);
    expect(isCompactType(TUPLE)).toBe(true);
    expect(isCompactType(BOUNDED)).toBe(true);
    expect(isCompactType({ kind: 'banana' })).toBe(false);
    assertCompactType(PAIR); // does not throw
  });
});
