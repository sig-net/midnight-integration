// The package's reason to exist: every claim the TypeScript twin makes is
// pinned here against the COMPILED fixture circuits (tests/fixtures/), which
// wrap the builtin serialize<T, N> / deserialize<T, N> pair. Run
// `yarn compile` in this package first — the tests import the generated
// bindings.
//
// Coverage per fixture struct:
//   - twin encode === circuit serialize, byte for byte (boundary values incl.)
//   - circuit deserialize accepts twin-encoded bytes and returns the values
//   - twin decode of circuit-serialized bytes returns the original values
//   - the deserialize-only shapes (VectorsDeep, Nested) prove the twin can
//     encode layouts circuits can READ even where compactc cannot re-serialize
//     them in-circuit (see the bug notes in serde-fixtures.compact)
//   - circuit REJECTIONS are pinned too: out-of-range bounded uint, enum and
//     Field encodings throw in-circuit exactly where the twin throws
//   - a second, independent oracle: @midnight-ntwrk/compact-runtime's
//     toBinaryRepr must agree with the twin on every shape, INCLUDING the
//     shapes compactc cannot compile serialize for

import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CompactTypeBoolean,
  CompactTypeBytes,
  CompactTypeEnum,
  CompactTypeField,
  CompactTypeUnsignedInteger,
  CompactTypeVector,
  toBinaryRepr,
  type CompactType as RuntimeCompactType,
} from '@midnight-ntwrk/compact-runtime';

import { pureCircuits } from './fixtures/managed/contract/index.js';
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

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

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

  it('VectorsDeep — circuits can READ shapes compactc cannot re-serialize', () => {
    expect(
      pureCircuits.deVectorsDeep(compactSerialize(VECTORS_DEEP, vectorsDeepValue, 52))
    ).toEqual(vectorsDeepValue);
  });

  it('Inner', () => {
    expect(pureCircuits.deInner(compactSerialize(INNER, innerValue, 25))).toEqual(innerValue);
  });

  it('Nested (two nesting levels) — deserialize-only shape, padded to 128', () => {
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
});

// ---- second oracle: compact-runtime's toBinaryRepr --------------------------

// An independent implementation of the packed layout that ships inside
// @midnight-ntwrk/compact-runtime (undocumented, test-oracle use ONLY, never
// a runtime dependency). Two things make it valuable: it was written by the
// Midnight team, and it can produce the layouts compactc cannot compile
// serialize<T, N> for (VectorsDeep, Nested), pinning the twin's serialize
// side where no circuit exists. It returns the packed bytes with no padding.
function runtimeType(type: CompactType): RuntimeCompactType<unknown> {
  switch (type.kind) {
    case 'boolean':
      return CompactTypeBoolean as RuntimeCompactType<unknown>;
    case 'field':
      return CompactTypeField as RuntimeCompactType<unknown>;
    case 'uint': {
      const bound =
        'bits' in type && type.bits !== undefined
          ? 1n << BigInt(type.bits)
          : BigInt((type as { bound: number | bigint }).bound);
      return new CompactTypeUnsignedInteger(
        bound - 1n,
        compactSerializedSize(type)
      ) as RuntimeCompactType<unknown>;
    }
    case 'enum':
      return new CompactTypeEnum(
        type.variants - 1,
        compactSerializedSize(type)
      ) as RuntimeCompactType<unknown>;
    case 'bytes':
      return new CompactTypeBytes(type.length) as RuntimeCompactType<unknown>;
    case 'vector':
      return new CompactTypeVector(
        type.length,
        runtimeType(type.element)
      ) as RuntimeCompactType<unknown>;
    case 'tuple': {
      const elements = type.elements.map(runtimeType);
      return composite(elements, (value) => value as unknown[]);
    }
    case 'struct': {
      const elements = type.fields.map((f) => runtimeType(f.type));
      return composite(elements, (value) =>
        type.fields.map((f) => (value as Record<string, unknown>)[f.name])
      );
    }
  }
}

// Structs and tuples have no runtime class: compiled contracts emit ad-hoc
// descriptor objects that concatenate their members' alignments and values,
// and this mirrors that pattern.
function composite(
  elements: RuntimeCompactType<unknown>[],
  split: (value: unknown) => unknown[]
): RuntimeCompactType<unknown> {
  return {
    alignment: () => elements.flatMap((e) => e.alignment() as unknown[]),
    toValue: (value: unknown) => {
      const parts = split(value);
      return elements.flatMap((e, i) => e.toValue(parts[i]) as unknown[]);
    },
    fromValue: () => {
      throw new Error('oracle helper is serialize-only');
    },
  } as unknown as RuntimeCompactType<unknown>;
}

describe('toBinaryRepr (compact-runtime) agrees with the twin', () => {
  const shapes: [string, CompactType, CompactValue][] = [
    ['Primitives', PRIMITIVES, primitivesValue],
    ['Buffers', BUFFERS, buffersValue],
    ['VectorsPlain', VECTORS_PLAIN, vectorsPlainValue],
    ['VectorsDeep (no circuit serialize exists)', VECTORS_DEEP, vectorsDeepValue],
    ['Inner', INNER, innerValue],
    ['Nested (no circuit serialize exists)', NESTED, nestedValue],
    ['WithStdlib', WITH_STDLIB, stdlibValue],
    ['Bounded', BOUNDED, boundedValue],
    ['ZeroSizes', ZERO_SIZES, zeroSizesValue],
    ['tuple', TUPLE, tupleValue],
    ['tuple with struct', TUPLE_PAIR, tuplePairValue],
  ];

  for (const [name, type, value] of shapes) {
    it(name, () => {
      expect(hex(compactSerialize(type as never, value as never))).toBe(
        hex(toBinaryRepr(runtimeType(type), value))
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
    const bytes = compactSerialize(INNER, innerValue, 128);
    bytes[127] = 0xff;
    // The circuit reads only the packed prefix (empirically pinned).
    expect(pureCircuits.deInner(bytes.slice(0, 25))).toEqual(innerValue);
    expect(compactDeserialize(INNER, bytes, { ignorePadding: true })).toEqual(innerValue);
    expect(() => compactDeserialize(INNER, bytes)).toThrow(/non-zero padding/);
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
    const bytes = new Uint8Array(25);
    bytes[24] = 2;
    expect(pureCircuits.deInner(bytes)).toEqual({ pair: { a: 0n, b: 0n }, ok: false });
    expect(() => compactDeserialize(INNER, bytes)).toThrow(/invalid boolean byte 0x2/);
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
      /non-negative integer/
    );
    expect(() =>
      compactSerializedSize(bad({ kind: 'vector', length: 2.5, element: { kind: 'boolean' } }))
    ).toThrow(/non-negative integer/);
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
