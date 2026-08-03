// The golden-corpus model and its self-verifying builder. buildCorpus()
// derives every record from the COMPILED fixture circuits, the toBinaryRepr
// oracle and the TypeScript twin, and throws unless all applicable
// authorities agree byte-for-byte, so a corpus can only ever be written from
// an agreeing triple. The emitted JSONL is deterministic (fixed record order,
// fixed key order, no timestamps): the committed file must equal a
// regeneration byte-for-byte (see tests/corpus-guard.test.ts).
//
// Encoding conventions (also recorded in the header record): Uint/Field
// values and uint bounds as decimal strings, bytes as lowercase hex, enum
// variants as numbers, booleans as JSON booleans, vectors/tuples as arrays,
// structs as objects keyed by field name in declaration order.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  compactDeserialize,
  compactSerialize,
  compactSerializedSize,
  FIELD_MODULUS,
  type CompactType,
  type CompactValue,
} from '@sig-net/midnight-serde';

import {
  BIG,
  BOUNDED,
  boundedValue,
  BUFFERS,
  buffersValue,
  EITHER,
  eitherBothArms,
  EMPTY_TUPLE,
  INNER,
  innerFalseValue,
  innerValue,
  MAYBE_U64,
  NESTED,
  nestedValue,
  PAIR,
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
  vectorsDeepValue,
  VECTORS_PLAIN,
  vectorsPlainValue,
  WIDE,
  WITH_STDLIB,
  ZERO_SIZES,
  zeroSizesValue,
} from './descriptors.ts';
import { hex, oracleSerialize } from './oracle.ts';
import { mulberry32, randType, randValue, SWEEP_CASES, SWEEP_SEED } from './random.ts';
import { pureCircuits } from '../managed/contract/index.js';

/** The compactc release the fixture circuits are compiled with (the repo's pinned toolchain, NOT the CLI's self-reported version, which drops the -rc suffix). */
export const COMPACTC_VERSION = '0.33.0-rc.2';

/** Corpus schema version: bump only with a coordinated change to every consumer. */
export const CORPUS_SCHEMA = 1;

/** Rejection categories shared by every implementation's error model. */
export enum RejectCategory {
  UintRange = 'uint-range',
  EnumRange = 'enum-range',
  FieldRange = 'field-range',
  BooleanStrict = 'boolean-strict',
  PaddingNonZero = 'padding-nonzero',
  ShortBuffer = 'short-buffer',
}

/** JSON form of a descriptor: like CompactType but with `bound` as a decimal string. */
export type JsonType =
  | { kind: 'boolean' | 'field' }
  | { kind: 'uint'; bits: number }
  | { kind: 'uint'; bound: string }
  | { kind: 'bytes'; length: number }
  | { kind: 'enum'; variants: number }
  | { kind: 'vector'; length: number; element: JsonType }
  | { kind: 'tuple'; elements: JsonType[] }
  | { kind: 'struct'; fields: { name: string; type: JsonType }[] };

/** JSON form of a value under the header's encoding conventions. */
export type JsonValue = boolean | number | string | JsonValue[] | { [field: string]: JsonValue };

/** The first corpus line: provenance and encoding conventions. */
export interface HeaderRecord {
  record: 'header';
  schema: number;
  compactc: string;
  fixture: string;
  fixtureSha256: string;
  encoding: { uint: string; field: string; bytes: string; enum: string; bound: string };
}

/** A serialize expectation: value encodes to `packed`, right zero-padded to `n`. */
export interface SerializeRecord {
  record: 'serialize';
  name: string;
  type: JsonType;
  value: JsonValue;
  packed: string;
  n: number;
  provenance: 'circuit' | 'oracle';
}

/** A deserialize expectation: bytes decode to a value or reject with a category. */
export interface DeserializeRecord {
  record: 'deserialize';
  name: string;
  type: JsonType;
  bytes: string;
  options?: { ignorePadding?: boolean; lenientBooleans?: boolean };
  expect: { value: JsonValue } | { reject: RejectCategory };
  provenance: 'circuit' | 'twin';
}

/** A seeded random roundtrip case (twin == oracle asserted at generation). */
export interface SweepRecord {
  record: 'sweep';
  name: string;
  type: JsonType;
  value: JsonValue;
  packed: string;
  provenance: 'oracle';
}

export type CorpusRecord = HeaderRecord | SerializeRecord | DeserializeRecord | SweepRecord;

/**
 * Encode a descriptor to its corpus JSON form (`bound` always a decimal
 * string: bounds reach 2^248, past JSON's number range).
 *
 * @param type - the descriptor to encode
 * @returns the JSON form
 */
export function typeToJson(type: CompactType): JsonType {
  switch (type.kind) {
    case 'boolean':
    case 'field':
      return { kind: type.kind };
    case 'uint':
      return 'bits' in type && type.bits !== undefined
        ? { kind: 'uint', bits: type.bits }
        : { kind: 'uint', bound: String((type as { bound: number | bigint }).bound) };
    case 'bytes':
      return { kind: 'bytes', length: type.length };
    case 'enum':
      return { kind: 'enum', variants: type.variants };
    case 'vector':
      return { kind: 'vector', length: type.length, element: typeToJson(type.element) };
    case 'tuple':
      return { kind: 'tuple', elements: type.elements.map(typeToJson) };
    case 'struct':
      return {
        kind: 'struct',
        fields: type.fields.map((f) => ({ name: f.name, type: typeToJson(f.type) })),
      };
  }
}

/**
 * Decode a corpus JSON descriptor back to a CompactType (string bounds become
 * bigints, which the twin accepts in either form).
 *
 * @param json - the JSON form
 * @returns the runtime descriptor
 */
export function jsonToType(json: JsonType): CompactType {
  switch (json.kind) {
    case 'boolean':
    case 'field':
      return { kind: json.kind };
    case 'uint':
      return 'bits' in json ? { kind: 'uint', bits: json.bits } : { kind: 'uint', bound: BigInt(json.bound) };
    case 'bytes':
      return { kind: 'bytes', length: json.length };
    case 'enum':
      return { kind: 'enum', variants: json.variants };
    case 'vector':
      return { kind: 'vector', length: json.length, element: jsonToType(json.element) };
    case 'tuple':
      return { kind: 'tuple', elements: json.elements.map(jsonToType) };
    case 'struct':
      return {
        kind: 'struct',
        fields: json.fields.map((f) => ({ name: f.name, type: jsonToType(f.type) })),
      };
  }
}

/**
 * Encode a value to its corpus JSON form under a descriptor.
 *
 * @param type - the descriptor the value conforms to
 * @param value - the runtime value
 * @returns the JSON form
 */
export function valueToJson(type: CompactType, value: CompactValue): JsonValue {
  switch (type.kind) {
    case 'boolean':
      return value as boolean;
    case 'uint':
    case 'field':
      return (value as bigint).toString();
    case 'bytes':
      return hex(value as Uint8Array);
    case 'enum':
      return Number(value);
    case 'vector': {
      const elements = value as CompactValue[];
      return elements.map((e) => valueToJson(type.element, e));
    }
    case 'tuple': {
      const elements = value as CompactValue[];
      return elements.map((e, i) => valueToJson(type.elements[i]!, e));
    }
    case 'struct': {
      const record = value as { [field: string]: CompactValue };
      const out: { [field: string]: JsonValue } = {};
      for (const field of type.fields) {
        out[field.name] = valueToJson(field.type, record[field.name]!);
      }
      return out;
    }
  }
}

/**
 * Decode a corpus JSON value back to a runtime value under a descriptor.
 * Struct fields are read in DESCRIPTOR order, never JSON key order.
 *
 * @param type - the descriptor the value conforms to
 * @param json - the JSON form
 * @returns the runtime value
 */
export function jsonToValue(type: CompactType, json: JsonValue): CompactValue {
  switch (type.kind) {
    case 'boolean':
      return json as boolean;
    case 'uint':
    case 'field':
      return BigInt(json as string);
    case 'bytes': {
      const text = json as string;
      const out = new Uint8Array(text.length / 2);
      for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
      }
      return out;
    }
    case 'enum':
      return json as number;
    case 'vector':
      return (json as JsonValue[]).map((e) => jsonToValue(type.element, e));
    case 'tuple':
      return (json as JsonValue[]).map((e, i) => jsonToValue(type.elements[i]!, e));
    case 'struct': {
      const record = json as { [field: string]: JsonValue };
      const out: { [field: string]: CompactValue } = {};
      for (const field of type.fields) {
        out[field.name] = jsonToValue(field.type, record[field.name]!);
      }
      return out;
    }
  }
}

const FIXTURE_URL = new URL('../serde-fixtures.compact', import.meta.url);

/** Right-zero-pad packed bytes to the fixture circuit's Bytes<N>. */
function padTo(packed: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  out.set(packed);
  return out;
}

/** Deep value equality via the canonical JSON encoding. */
function sameValue(type: CompactType, a: CompactValue, b: CompactValue): boolean {
  return JSON.stringify(valueToJson(type, a)) === JSON.stringify(valueToJson(type, b));
}

interface SerializeCase {
  name: string;
  type: CompactType;
  value: CompactValue;
  /** The fixture circuit's Bytes<N> width. */
  n: number;
  /** The ser circuit, absent for the deserialize-only shapes. */
  ser?: (() => Uint8Array) | undefined;
  /** The de circuit, absent where the fixture has no decoder (Maybe constructors). */
  de?: ((bytes: Uint8Array) => CompactValue) | undefined;
}

const pc = pureCircuits;

// One case per fixture circuit family; names are the stable corpus slugs.
const SERIALIZE_CASES: SerializeCase[] = [
  { name: 'primitives', type: PRIMITIVES, value: primitivesValue, n: 89, ser: () => pc.serPrimitives(primitivesValue), de: (b) => pc.dePrimitives(b) },
  { name: 'buffers', type: BUFFERS, value: buffersValue, n: 64, ser: () => pc.serBuffers(buffersValue), de: (b) => pc.deBuffers(b) },
  { name: 'vectors-plain', type: VECTORS_PLAIN, value: vectorsPlainValue, n: 56, ser: () => pc.serVectorsPlain(vectorsPlainValue), de: (b) => pc.deVectorsPlain(b) },
  { name: 'vectors-deep', type: VECTORS_DEEP, value: vectorsDeepValue, n: 52, de: (b) => pc.deVectorsDeep(b) },
  { name: 'inner', type: INNER, value: innerValue, n: 25, ser: () => pc.serInner(innerValue), de: (b) => pc.deInner(b) },
  { name: 'inner-false', type: INNER, value: innerFalseValue, n: 25, ser: () => pc.serInner(innerFalseValue), de: (b) => pc.deInner(b) },
  { name: 'nested', type: NESTED, value: nestedValue, n: 128, de: (b) => pc.deNested(b) },
  { name: 'with-stdlib', type: WITH_STDLIB, value: stdlibValue, n: 41, ser: () => pc.serStdlib(stdlibValue), de: (b) => pc.deStdlib(b) },
  { name: 'bounded', type: BOUNDED, value: boundedValue, n: 8, ser: () => pc.serBounded(boundedValue), de: (b) => pc.deBounded(b) },
  { name: 'zero-sizes', type: ZERO_SIZES, value: zeroSizesValue, n: 1, ser: () => pc.serZeroSizes(zeroSizesValue), de: (b) => pc.deZeroSizes(b) },
  { name: 'tuple', type: TUPLE, value: tupleValue, n: 7, ser: () => pc.serTuple(tupleValue), de: (b) => pc.deTuple(b) },
  { name: 'tuple-pair', type: TUPLE_PAIR, value: tuplePairValue, n: 25, ser: () => pc.serTuplePair(tuplePairValue), de: (b) => pc.deTuplePair(b) },
  { name: 'u12', type: U12, value: 4095n, n: 2, ser: () => pc.serU12(4095n), de: (b) => pc.deU12(b) },
  { name: 'wide', type: WIDE, value: 69999n, n: 3, ser: () => pc.serWide(69999n), de: (b) => pc.deWide(b) },
  { name: 'solo', type: SOLO, value: 0, n: 1, ser: () => pc.serSolo(0), de: (b) => pc.deSolo(b) },
  { name: 'empty-tuple', type: EMPTY_TUPLE, value: [], n: 1, ser: () => pc.serEmptyTuple([]), de: (b) => pc.deEmptyTuple(b) },
  { name: 'big', type: BIG, value: 299, n: 2, ser: () => pc.serBig(299), de: (b) => pc.deBig(b) },
  { name: 'either-both-arms', type: EITHER, value: eitherBothArms, n: 41, ser: () => pc.serEither(eitherBothArms), de: (b) => pc.deEither(b) },
  { name: 'either-left', type: EITHER, value: { is_left: true, left: 4242n, right: new Uint8Array(32) }, n: 41, ser: () => pc.serLeft(4242n), de: (b) => pc.deEither(b) },
  { name: 'either-right', type: EITHER, value: { is_left: false, left: 0n, right: new Uint8Array(32).fill(0xcd) }, n: 41, ser: () => pc.serRight(new Uint8Array(32).fill(0xcd)), de: (b) => pc.deEither(b) },
  { name: 'maybe-some', type: MAYBE_U64, value: { is_some: true, value: 4242n }, n: 9, ser: () => pc.serSomeU64(4242n) },
  { name: 'maybe-none', type: MAYBE_U64, value: { is_some: false, value: 0n }, n: 9, ser: () => pc.serNoneU64() },
];

interface RejectionCase {
  name: string;
  type: CompactType;
  bytes: Uint8Array;
  reject: RejectCategory;
  /** The de circuit expected to throw on the same bytes; absent for twin-only categories. */
  de?: ((bytes: Uint8Array) => CompactValue) | undefined;
}

/** Little-endian bytes of a value at a width (corpus construction only). */
function le(value: bigint, width: number): number[] {
  const out: number[] = [];
  let v = value;
  for (let i = 0; i < width; i++) {
    out.push(Number(v & 0xffn));
    v >>= 8n;
  }
  return out;
}

const REJECTION_CASES: RejectionCase[] = [
  // Bounded struct: small (2 bytes LE) then unit (0) then status then marker.
  { name: 'bounded-uint-at-bound', type: BOUNDED, bytes: Uint8Array.from([...le(1000n, 2), 0, 0, 0, 0, 0, 0]), reject: RejectCategory.UintRange, de: (b) => pc.deBounded(b) },
  { name: 'bounded-enum-at-count', type: BOUNDED, bytes: Uint8Array.from([0, 0, 3, 0, 0, 0, 0, 0]), reject: RejectCategory.EnumRange, de: (b) => pc.deBounded(b) },
  { name: 'u12-at-bound', type: U12, bytes: Uint8Array.from(le(4096n, 2)), reject: RejectCategory.UintRange, de: (b) => pc.deU12(b) },
  { name: 'wide-at-bound', type: WIDE, bytes: Uint8Array.from(le(70000n, 3)), reject: RejectCategory.UintRange, de: (b) => pc.deWide(b) },
  { name: 'big-at-count', type: BIG, bytes: Uint8Array.from(le(300n, 2)), reject: RejectCategory.EnumRange, de: (b) => pc.deBig(b) },
  { name: 'field-at-modulus', type: PRIMITIVES, bytes: padTo(Uint8Array.from([...new Uint8Array(57), ...le(FIELD_MODULUS, 32)]), 89), reject: RejectCategory.FieldRange, de: (b) => pc.dePrimitives(b) },
  // Twin-only: circuits consume a fixed Bytes<N>, so a short buffer cannot reach them.
  { name: 'pair-short-buffer', type: PAIR, bytes: new Uint8Array(10), reject: RejectCategory.ShortBuffer },
];

/**
 * Build the full corpus from the compiled circuits, the oracle and the twin.
 * Throws on ANY disagreement between the authorities: a corpus can only be
 * produced from an agreeing triple.
 *
 * @returns every corpus record in canonical order
 * @throws if any authority disagrees with another on any record
 */
export function buildCorpus(): CorpusRecord[] {
  const fixture = readFileSync(FIXTURE_URL);
  const records: CorpusRecord[] = [
    {
      record: 'header',
      schema: CORPUS_SCHEMA,
      compactc: COMPACTC_VERSION,
      fixture: 'serde-fixtures.compact',
      fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
      encoding: {
        uint: 'decimal string',
        field: 'decimal string',
        bytes: 'lowercase hex',
        enum: 'number',
        bound: 'decimal string',
      },
    },
  ];

  for (const c of SERIALIZE_CASES) {
    const twinPacked = compactSerialize(c.type as never, c.value as never);
    const oraclePacked = oracleSerialize(c.type, c.value);
    if (hex(twinPacked) !== hex(oraclePacked)) {
      throw new Error(`${c.name}: twin and oracle disagree: ${hex(twinPacked)} vs ${hex(oraclePacked)}`);
    }
    const padded = padTo(twinPacked, c.n);
    let provenance: 'circuit' | 'oracle' = 'oracle';
    if (c.ser) {
      const circuit = c.ser();
      if (hex(circuit) !== hex(padded)) {
        throw new Error(`${c.name}: circuit serialize disagrees: ${hex(circuit)} vs ${hex(padded)}`);
      }
      provenance = 'circuit';
    }
    records.push({
      record: 'serialize',
      name: c.name,
      type: typeToJson(c.type),
      value: valueToJson(c.type, c.value),
      packed: hex(twinPacked),
      n: c.n,
      provenance,
    });

    // Companion decode expectation over the padded bytes.
    let deProvenance: 'circuit' | 'twin' = 'twin';
    if (c.de) {
      const decoded = c.de(padded);
      if (!sameValue(c.type, decoded, c.value)) {
        throw new Error(`${c.name}: circuit deserialize returned a different value`);
      }
      deProvenance = 'circuit';
    }
    const twinDecoded = compactDeserialize(c.type, padded);
    if (!sameValue(c.type, twinDecoded, c.value)) {
      throw new Error(`${c.name}: twin deserialize returned a different value`);
    }
    records.push({
      record: 'deserialize',
      name: `${c.name}-roundtrip`,
      type: typeToJson(c.type),
      bytes: hex(padded),
      expect: { value: valueToJson(c.type, c.value) },
      provenance: deProvenance,
    });
  }

  for (const c of REJECTION_CASES) {
    if (c.de) {
      let threw = false;
      try {
        c.de(c.bytes);
      } catch {
        threw = true;
      }
      if (!threw) throw new Error(`${c.name}: circuit ACCEPTED bytes expected to reject`);
    }
    let twinThrew = false;
    try {
      compactDeserialize(c.type, c.bytes);
    } catch {
      twinThrew = true;
    }
    if (!twinThrew) throw new Error(`${c.name}: twin ACCEPTED bytes expected to reject`);
    records.push({
      record: 'deserialize',
      name: c.name,
      type: typeToJson(c.type),
      bytes: hex(c.bytes),
      expect: { reject: c.reject },
      provenance: c.de ? 'circuit' : 'twin',
    });
  }

  // The two documented divergences, as record pairs over the same bytes:
  // strict rejection (twin behaviour) + the flipping flag with the value the
  // live circuit returns.
  const boolBytes = new Uint8Array(25);
  boolBytes[24] = 0xff;
  const lenientDecoded = pc.deInner(boolBytes);
  if (!sameValue(INNER, lenientDecoded, { pair: { a: 0n, b: 0n }, ok: false })) {
    throw new Error('divergence: circuit boolean decode of 0xff changed behaviour');
  }
  records.push({
    record: 'deserialize',
    name: 'inner-bool-0xff-strict',
    type: typeToJson(INNER),
    bytes: hex(boolBytes),
    expect: { reject: RejectCategory.BooleanStrict },
    provenance: 'twin',
  });
  records.push({
    record: 'deserialize',
    name: 'inner-bool-0xff-lenient',
    type: typeToJson(INNER),
    bytes: hex(boolBytes),
    options: { lenientBooleans: true },
    expect: { value: valueToJson(INNER, lenientDecoded) },
    provenance: 'circuit',
  });

  const paddingBytes = padTo(compactSerialize(BOUNDED as never, boundedValue as never), 8);
  paddingBytes[7] = 0x99;
  const paddingDecoded = pc.deBounded(paddingBytes);
  if (!sameValue(BOUNDED, paddingDecoded, boundedValue)) {
    throw new Error('divergence: circuit padding behaviour changed');
  }
  records.push({
    record: 'deserialize',
    name: 'bounded-padding-garbage-strict',
    type: typeToJson(BOUNDED),
    bytes: hex(paddingBytes),
    expect: { reject: RejectCategory.PaddingNonZero },
    provenance: 'twin',
  });
  records.push({
    record: 'deserialize',
    name: 'bounded-padding-garbage-ignored',
    type: typeToJson(BOUNDED),
    bytes: hex(paddingBytes),
    options: { ignorePadding: true },
    expect: { value: valueToJson(BOUNDED, boundedValue) },
    provenance: 'circuit',
  });

  // The seeded sweep: same rng interleaving as the original property tests.
  const rng = mulberry32(SWEEP_SEED);
  for (let i = 0; i < SWEEP_CASES; i++) {
    const type = randType(rng, 3);
    const value = randValue(rng, type);
    const twinPacked = compactSerialize(type as never, value as never);
    if (twinPacked.length !== compactSerializedSize(type)) {
      throw new Error(`sweep-${i}: packed length disagrees with compactSerializedSize`);
    }
    if (hex(twinPacked) !== hex(oracleSerialize(type, value))) {
      throw new Error(`sweep-${i}: twin and oracle disagree`);
    }
    if (!sameValue(type, compactDeserialize(type, twinPacked), value)) {
      throw new Error(`sweep-${i}: strict twin roundtrip failed`);
    }
    records.push({
      record: 'sweep',
      name: `sweep-${String(i).padStart(3, '0')}`,
      type: typeToJson(type),
      value: valueToJson(type, value),
      packed: hex(twinPacked),
      provenance: 'oracle',
    });
  }

  return records;
}

/**
 * The canonical text of a corpus: one JSON object per line, LF separated,
 * trailing newline. The committed file must equal this byte-for-byte.
 *
 * @param records - the corpus records in canonical order
 * @returns the JSONL text
 */
export function corpusText(records: CorpusRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** Resolved URL of the committed corpus file. */
export const CORPUS_URL = new URL('../corpus/serde-corpus.jsonl', import.meta.url);

/**
 * Load and parse the COMMITTED corpus file.
 *
 * @returns every record, header first
 * @throws if the file is missing or malformed
 */
export function loadCorpus(): CorpusRecord[] {
  const text = readFileSync(CORPUS_URL, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CorpusRecord);
}
