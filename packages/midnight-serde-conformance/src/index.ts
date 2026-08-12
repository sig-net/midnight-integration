// The conformance kit's export surface: the compiled fixture circuits, the
// shared descriptor tables and values, the toBinaryRepr oracle, the corpus
// model with its JSON codecs, and the committed-corpus loader. This package
// owns the fixtures every midnight-serde implementation's test suite
// consumes.

export { SCHEMA_CASES, type SchemaCase } from "./abi-schemas.ts";
export * from "./descriptors.ts";
// Re-exported so implementation test suites can derive descriptors from
// on-chain schema strings through the PRODUCTION mapping without depending
// on @sig-net/midnight themselves.
export { pureCircuits } from "../managed/contract/index.js";
export {
  buildCorpus,
  COMPACTC_VERSION,
  CORPUS_SCHEMA,
  CORPUS_URL,
  type CorpusRecord,
  corpusText,
  type DeserializeRecord,
  type HeaderRecord,
  jsonToType,
  jsonToValue,
  type JsonType,
  type JsonValue,
  loadCorpus,
  RejectCategory,
  type SchemaRecord,
  type SerializeRecord,
  type SweepRecord,
  typeToJson,
  valueToJson,
} from "./corpus.ts";
export { byteWidthOfMax, hex, oracleSerialize, runtimeType } from "./oracle.ts";
export {
  mulberry32,
  randBigIntBelow,
  randInt,
  randType,
  randValue,
  SWEEP_CASES,
  SWEEP_SEED,
} from "./random.ts";
export { respondSchemaDescriptor } from "@sig-net/midnight";
