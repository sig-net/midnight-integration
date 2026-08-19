// Replays every record of the committed golden corpus through the TypeScript
// twin. The corpus is generated from the compiled fixture circuits and the
// toBinaryRepr oracle (see the conformance package), so a green run here
// proves the twin agrees with the committed ground truth byte for byte, and
// every other implementation pinned to the same corpus (the Rust crate)
// inherits agreement with the twin transitively.

import {
  CORPUS_SCHEMA,
  type CorpusRecord,
  type DeserializeRecord,
  type HeaderRecord,
  hex,
  jsonToType,
  jsonToValue,
  type JsonValue,
  loadCorpus,
  RejectCategory,
  respondSchemaDescriptor,
  type SchemaRecord,
  type SerializeRecord,
  type SweepRecord,
  typeToJson,
  valueToJson,
} from "@midnight-protocol/midnight-serde-conformance";
import { describe, expect, it } from "vitest";

import { compactDeserialize, compactSerialize, compactSerializedSize } from "../src/index.ts";

// The twin's error messages, keyed by the corpus's language-neutral
// rejection categories. Message wording is this package's own contract,
// and the categories are the cross-implementation contract.
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
const serializeRecords = records.filter((r): r is SerializeRecord => r.record === "serialize");
const deserializeRecords = records.filter(
  (r): r is DeserializeRecord => r.record === "deserialize",
);
const deserializeDecodes = deserializeRecords.filter(
  (r): r is DeserializeRecord & { expect: { value: JsonValue } } => "value" in r.expect,
);
const deserializeRejects = deserializeRecords.filter(
  (r): r is DeserializeRecord & { expect: { reject: RejectCategory } } => "reject" in r.expect,
);
const schemaRecords = records.filter((r): r is SchemaRecord => r.record === "schema");
const sweepRecords = records.filter((r): r is SweepRecord => r.record === "sweep");

describe("golden corpus replay", () => {
  it("carries the expected header", () => {
    expect(header.record).toBe("header");
    expect(header.schema).toBe(CORPUS_SCHEMA);
    expect(serializeRecords.length).toBeGreaterThan(0);
    expect(deserializeDecodes.length).toBeGreaterThan(0);
    expect(deserializeRejects.length).toBeGreaterThan(0);
    expect(schemaRecords.length).toBeGreaterThan(0);
    expect(sweepRecords.length).toBeGreaterThan(0);
  });

  it.each(serializeRecords.map((r) => [r.name, r] as const))(
    "serialize %s: twin emits the recorded bytes, packed and padded",
    (_name, record) => {
      const type = jsonToType(record.type);
      const value = jsonToValue(type, record.value);
      expect(hex(compactSerialize(type as never, value as never))).toBe(record.packed);
      const padded = record.packed + "00".repeat(record.n - record.packed.length / 2);
      expect(hex(compactSerialize(type as never, value as never, record.n))).toBe(padded);
    },
  );

  it.each(deserializeDecodes.map((r) => [r.name, r] as const))(
    "deserialize %s: twin decodes as recorded",
    (_name, record) => {
      const type = jsonToType(record.type);
      const bytes = jsonToValue(
        { kind: "bytes", length: record.bytes.length / 2 },
        record.bytes,
      ) as Uint8Array;
      const decoded = compactDeserialize(type, bytes, record.options ?? {});
      expect(valueToJson(type, decoded)).toEqual(record.expect.value);
    },
  );

  it.each(deserializeRejects.map((r) => [r.name, r] as const))(
    "deserialize %s: twin rejects as recorded",
    (_name, record) => {
      const type = jsonToType(record.type);
      const bytes = jsonToValue(
        { kind: "bytes", length: record.bytes.length / 2 },
        record.bytes,
      ) as Uint8Array;
      expect(() => compactDeserialize(type, bytes, record.options ?? {})).toThrow(
        REJECT_PATTERNS[record.expect.reject],
      );
    },
  );

  // The SignBidirectionalEvent pipeline: the on-chain ABI-style schema JSON
  // (outputDeserializationSchema / respondSerializationSchema) drives the
  // descriptor the twin serializes with. The descriptors here are derived
  // from the schema STRINGS through the production mapping
  // (@sig-net/midnight's respondSchemaDescriptor, re-exported by the
  // conformance kit), so this replay proves schema -> descriptor -> bytes
  // works seamlessly, not just descriptor -> bytes.
  it("schema: the corpus carries the exact on-chain schema literals from test-caller-contract", () => {
    const schemas = schemaRecords.map((r) => r.schema);
    const singleBool = '[{"name":"success","type":"bool"}]';
    const boolUint256 = '[{"name":"success","type":"bool"},{"name":"amount","type":"uint256"}]';
    expect(schemas).toContain(singleBool);
    expect(schemas).toContain(boolUint256);
    // The literals are carried on chain as Bytes<34> / Bytes<69>: exact width.
    expect(new TextEncoder().encode(singleBool)).toHaveLength(34);
    expect(new TextEncoder().encode(boolUint256)).toHaveLength(69);
  });

  it.each(schemaRecords.map((r) => [r.name, r] as const))(
    "schema %s: the schema string maps to the recorded descriptor and the twin matches the bytes",
    (_name, record) => {
      const descriptor = respondSchemaDescriptor(record.schema);
      expect(typeToJson(descriptor)).toEqual(record.type);
      const value = jsonToValue(descriptor, record.value);
      expect(hex(compactSerialize(descriptor as never, value as never))).toBe(record.packed);
      const bytes = jsonToValue(
        { kind: "bytes", length: record.packed.length / 2 },
        record.packed,
      ) as Uint8Array;
      expect(valueToJson(descriptor, compactDeserialize(descriptor, bytes))).toEqual(record.value);
    },
  );

  it.each(sweepRecords.map((r) => [r.name, r] as const))(
    "%s: the seeded case sizes, encodes and roundtrips",
    (_name, record) => {
      const type = jsonToType(record.type);
      const value = jsonToValue(type, record.value);
      expect(compactSerializedSize(type) * 2).toBe(record.packed.length);
      const packed = compactSerialize(type as never, value as never);
      expect(hex(packed)).toBe(record.packed);
      expect(valueToJson(type, compactDeserialize(type, packed))).toEqual(record.value);
    },
  );
});
