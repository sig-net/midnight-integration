// The seeded random descriptor/value generator behind the corpus's sweep
// records. DO NOT change its behaviour: the committed corpus freezes its
// output, and any drift shows up as a corpus-guard failure, not a silent
// change.
//
// Deterministic on purpose: a fixed seed means every regeneration produces
// the same cases.

import { FIELD_MODULUS, type CompactType, type CompactValue } from '@sig-net/midnight-serde';

/** The seed the corpus sweep is generated from. */
export const SWEEP_SEED = 0xc0ffee;

/** The number of sweep cases in the corpus. */
export const SWEEP_CASES = 400;

/**
 * mulberry32: tiny, deterministic, good enough distribution for test-case
 * generation.
 *
 * @param seed - 32-bit seed
 * @returns a function producing floats in [0, 1)
 */
export function mulberry32(seed: number): () => number {
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

/**
 * Uniform-ish integer in [min, max], inclusive.
 *
 * @param rng - the random source
 * @param min - inclusive lower bound
 * @param max - inclusive upper bound
 * @returns an integer in the range
 */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * A bigint in [0, bound), biased towards the boundaries (where bugs live).
 *
 * @param rng - the random source
 * @param bound - exclusive upper bound
 * @returns a bigint below the bound
 */
export function randBigIntBelow(rng: Rng, bound: bigint): bigint {
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

/**
 * A random descriptor tree, leaves-only at depth 0.
 *
 * @param rng - the random source
 * @param depth - maximum remaining nesting depth
 * @returns a valid CompactType
 */
export function randType(rng: Rng, depth: number): CompactType {
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

/**
 * A random in-range value for a descriptor.
 *
 * @param rng - the random source
 * @param type - the descriptor to generate for
 * @returns a value the twin must accept
 */
export function randValue(rng: Rng, type: CompactType): CompactValue {
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
