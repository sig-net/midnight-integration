// Replays every record of the committed golden corpus through the TypeScript
// twin. The corpus is generated from the compiled fixture circuits and the
// toBinaryRepr oracle (see the conformance package), so a green run here
// proves the twin agrees with the committed ground truth byte for byte, and
// every other implementation pinned to the same corpus (the Rust crate)
// inherits agreement with the twin transitively.

import { describe, expect, it } from 'vitest';

import {
  CORPUS_SCHEMA,
  hex,
  jsonToType,
  jsonToValue,
  loadCorpus,
  RejectCategory,
  valueToJson,
  type CorpusRecord,
  type DeserializeRecord,
  type HeaderRecord,
  type SerializeRecord,
  type SweepRecord,
} from '@midnight-protocol/midnight-serde-conformance';
import { compactDeserialize, compactSerialize, compactSerializedSize } from '../src/index.ts';

// The twin's error messages, keyed by the corpus's language-neutral
// rejection categories. Message wording is this package's own contract;
// the categories are the cross-implementation one.
const REJECT_PATTERNS: Record<RejectCategory, RegExp> = {
  [RejectCategory.UintRange]: /exceeds Uint/,
  [RejectCategory.EnumRange]: /exceeds the last variant index/,
  [RejectCategory.FieldRange]: /not below the Field modulus/,
  [RejectCategory.BooleanStrict]: /invalid boolean byte/,
  [RejectCategory.PaddingNonZero]: /non-zero padding/,
  [RejectCategory.ShortBuffer]: /needs \d+ bytes/,
};

const records: CorpusRecord[] = loadCorpus();
const header = records[0] as HeaderRecord;
const serializeRecords = records.filter((r): r is SerializeRecord => r.record === 'serialize');
const deserializeRecords = records.filter((r): r is DeserializeRecord => r.record === 'deserialize');
const sweepRecords = records.filter((r): r is SweepRecord => r.record === 'sweep');

describe('golden corpus replay', () => {
  it('carries the expected header', () => {
    expect(header.record).toBe('header');
    expect(header.schema).toBe(CORPUS_SCHEMA);
    expect(serializeRecords.length).toBeGreaterThan(0);
    expect(deserializeRecords.length).toBeGreaterThan(0);
    expect(sweepRecords.length).toBeGreaterThan(0);
  });

  it.each(serializeRecords.map((r) => [r.name, r] as const))(
    'serialize %s: twin emits the recorded bytes, packed and padded',
    (_name, record) => {
      const type = jsonToType(record.type);
      const value = jsonToValue(type, record.value);
      expect(hex(compactSerialize(type as never, value as never))).toBe(record.packed);
      const padded = record.packed + '00'.repeat(record.n - record.packed.length / 2);
      expect(hex(compactSerialize(type as never, value as never, record.n))).toBe(padded);
    }
  );

  it.each(deserializeRecords.map((r) => [r.name, r] as const))(
    'deserialize %s: twin decodes (or rejects) as recorded',
    (_name, record) => {
      const type = jsonToType(record.type);
      const bytes = jsonToValue({ kind: 'bytes', length: record.bytes.length / 2 }, record.bytes) as Uint8Array;
      if ('value' in record.expect) {
        const decoded = compactDeserialize(type, bytes, record.options ?? {});
        expect(valueToJson(type, decoded)).toEqual(record.expect.value);
      } else {
        const category = record.expect.reject;
        expect(() => compactDeserialize(type, bytes, record.options ?? {})).toThrow(
          REJECT_PATTERNS[category]
        );
      }
    }
  );

  it('sweep: every seeded case sizes, encodes and roundtrips', () => {
    for (const record of sweepRecords) {
      const type = jsonToType(record.type);
      const value = jsonToValue(type, record.value);
      expect(compactSerializedSize(type) * 2, record.name).toBe(record.packed.length);
      const packed = compactSerialize(type as never, value as never);
      expect(hex(packed), record.name).toBe(record.packed);
      expect(valueToJson(type, compactDeserialize(type, packed)), record.name).toEqual(record.value);
    }
  });
});
