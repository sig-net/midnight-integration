// The conformance kit's export surface: the compiled fixture circuits, the
// shared descriptor tables and values, the toBinaryRepr oracle, the corpus
// model with its JSON codecs, and the committed-corpus loader. Every
// midnight-serde implementation's test suite consumes this package instead of
// owning fixtures of its own.

export * from './descriptors.ts';
export { byteWidthOfMax, hex, oracleSerialize, runtimeType } from './oracle.ts';
export {
  buildCorpus,
  COMPACTC_VERSION,
  CORPUS_SCHEMA,
  CORPUS_URL,
  corpusText,
  jsonToType,
  jsonToValue,
  loadCorpus,
  RejectCategory,
  typeToJson,
  valueToJson,
  type CorpusRecord,
  type DeserializeRecord,
  type HeaderRecord,
  type JsonType,
  type JsonValue,
  type SerializeRecord,
  type SweepRecord,
} from './corpus.ts';
export {
  mulberry32,
  randBigIntBelow,
  randInt,
  randType,
  randValue,
  SWEEP_CASES,
  SWEEP_SEED,
} from './random.ts';
export { pureCircuits } from '../managed/contract/index.js';
