// Regenerates the committed golden corpus. Explicitly human-invoked
// (`yarn workspace @midnight-protocol/midnight-serde-conformance generate`):
// the guard test only ever COMPARES, never writes. Requires the compiled
// fixture circuits (`yarn compile` first).

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildCorpus, CORPUS_URL, corpusText } from "./corpus.ts";

const records = buildCorpus();
writeFileSync(CORPUS_URL, corpusText(records));
console.log(`wrote ${String(records.length)} records to ${fileURLToPath(CORPUS_URL)}`);
