// Seeded randomised coverage on top of the hand-picked fixtures in
// serde.test.ts: hundreds of random descriptor trees and random in-range
// values, each driven through
//   - compactSerializedSize === encoded length
//   - twin encode → strict twin decode roundtrip
//   - agreement with the toBinaryRepr oracle (independent widths, see
//     tests/helpers.ts)
//   - random right-padding: strict decode of zero padding, rejection of
//     injected garbage, acceptance of the same garbage with ignorePadding
//
// Deterministic on purpose: a fixed seed means a failure here reproduces
// every run, so this stays CI-friendly while sweeping far more of the shape
// space than fixtures can. No property-testing dependency: the generator is
// ~80 lines and the package keeps zero runtime AND minimal dev dependencies.

import { describe, expect, it } from 'vitest';

import { hex, oracleSerialize } from './helpers.ts';
import {
  compactDeserialize,
  compactSerialize,
  compactSerializedSize,
  FIELD_MODULUS,
  type CompactType,
  type CompactValue,
} from '../src/index.ts';

// mulberry32: tiny, deterministic, good enough distribution for test-case
// generation.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

/** Uniform-ish integer in [min, max], inclusive. */
function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** A bigint in [0, bound), biased towards the boundaries (where bugs live). */
function randBigIntBelow(rng: Rng, bound: bigint): bigint {
  if (bound <= 1n) return 0n;
  const roll = rng();
  if (roll < 0.15) return 0n;
  if (roll < 0.3) return bound - 1n;
  let v = 0n;
  const bytes = (bound - 1n).toString(16).length / 2 + 1;
  for (let i = 0; i < bytes; i++) {
    v = (v << 8n) | BigInt(randInt(rng, 0, 255));
  }
  return v % bound;
}

function randType(rng: Rng, depth: number): CompactType {
  const leaves = ['boolean', 'field', 'uintBits', 'uintBound', 'bytes', 'enum'] as const;
  const all = [...leaves, 'vector', 'tuple', 'struct'] as const;
  const pick = (depth > 0 ? all : leaves)[randInt(rng, 0, (depth > 0 ? all : leaves).length - 1)]!;
  switch (pick) {
    case 'boolean':
      return { kind: 'boolean' };
    case 'field':
      return { kind: 'field' };
    case 'uintBits':
      return { kind: 'uint', bits: randInt(rng, 1, 248) };
    case 'uintBound': {
      // Bounds across the whole legal range, including the zero-width bound 1.
      const bits = randInt(rng, 0, 248);
      const bound = randBigIntBelow(rng, 1n << BigInt(bits)) + 1n;
      // Exercise both descriptor forms: number bounds below 2^53, bigint above.
      return bound <= BigInt(Number.MAX_SAFE_INTEGER) && rng() < 0.5
        ? { kind: 'uint', bound: Number(bound) }
        : { kind: 'uint', bound };
    }
    case 'bytes':
      return { kind: 'bytes', length: randInt(rng, 0, 24) };
    case 'enum':
      return { kind: 'enum', variants: randInt(rng, 1, 600) };
    case 'vector':
      return { kind: 'vector', length: randInt(rng, 0, 3), element: randType(rng, depth - 1) };
    case 'tuple': {
      const elements = Array.from({ length: randInt(rng, 0, 3) }, () => randType(rng, depth - 1));
      return { kind: 'tuple', elements };
    }
    case 'struct': {
      const fields = Array.from({ length: randInt(rng, 0, 3) }, (_, i) => ({
        name: `f${i}`,
        type: randType(rng, depth - 1),
      }));
      return { kind: 'struct', fields };
    }
  }
}

function randValue(rng: Rng, type: CompactType): CompactValue {
  switch (type.kind) {
    case 'boolean':
      return rng() < 0.5;
    case 'field':
      return randBigIntBelow(rng, FIELD_MODULUS);
    case 'uint': {
      const bound =
        'bits' in type && type.bits !== undefined
          ? 1n << BigInt(type.bits)
          : BigInt((type as { bound: number | bigint }).bound);
      return randBigIntBelow(rng, bound);
    }
    case 'bytes':
      return Uint8Array.from({ length: type.length }, () => randInt(rng, 0, 255));
    case 'enum':
      return randInt(rng, 0, type.variants - 1);
    case 'vector':
      return Array.from({ length: type.length }, () => randValue(rng, type.element));
    case 'tuple':
      return type.elements.map((e) => randValue(rng, e));
    case 'struct': {
      const value: { [field: string]: CompactValue } = {};
      for (const field of type.fields) value[field.name] = randValue(rng, field.type);
      return value;
    }
  }
}

const CASES = 400;

describe(`randomised sweep over ${CASES} descriptor/value pairs (seed 0xC0FFEE)`, () => {
  const rng = mulberry32(0xc0ffee);
  const cases = Array.from({ length: CASES }, () => {
    const type = randType(rng, 3);
    return { type, value: randValue(rng, type) };
  });

  it('compactSerializedSize equals the encoded length', () => {
    for (const { type, value } of cases) {
      expect(compactSerialize(type as never, value as never)).toHaveLength(
        compactSerializedSize(type)
      );
    }
  });

  it('strict twin decode inverts twin encode', () => {
    for (const { type, value } of cases) {
      const decoded = compactDeserialize(type, compactSerialize(type as never, value as never));
      expect(decoded).toEqual(value);
    }
  });

  it('toBinaryRepr (independent widths) agrees with every encoding', () => {
    for (const { type, value } of cases) {
      expect(hex(compactSerialize(type as never, value as never))).toBe(
        hex(oracleSerialize(type, value))
      );
    }
  });

  it('padding: zero padding roundtrips strictly, garbage only via ignorePadding', () => {
    const padRng = mulberry32(0xbadc0de);
    for (const { type, value } of cases.slice(0, 120)) {
      const size = compactSerializedSize(type);
      const padTo = size + randInt(padRng, 1, 16);
      const padded = compactSerialize(type as never, value as never, padTo);
      expect(padded).toHaveLength(padTo);
      expect(compactDeserialize(type, padded)).toEqual(value);

      padded[size + randInt(padRng, 0, padTo - size - 1)] = randInt(padRng, 1, 255);
      expect(() => compactDeserialize(type, padded)).toThrow(/non-zero padding/);
      expect(compactDeserialize(type, padded, { ignorePadding: true })).toEqual(value);
    }
  });
});
