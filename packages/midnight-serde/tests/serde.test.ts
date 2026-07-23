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

import { describe, expect, expectTypeOf, it } from 'vitest';

import { pureCircuits } from './fixtures/managed/contract/index.js';
import {
  compactDeserialize,
  compactSerialize,
  compactSerializedSize,
  FIELD_MODULUS,
  type CompactType,
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
});

// ---- twin decode of circuit bytes ------------------------------------------

describe('compactDeserialize inverts the compiled circuits', () => {
  it('Primitives', () => {
    expect(compactDeserialize(PRIMITIVES, pureCircuits.serPrimitives(primitivesValue))).toEqual(
      primitivesValue
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
});
