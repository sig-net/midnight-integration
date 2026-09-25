import assert from "node:assert/strict";

import { type CorpusRecord, type JsonType, RejectCategory } from "./corpus.ts";

function descriptorKinds(type: JsonType): string[] {
  const children =
    type.kind === "struct"
      ? type.fields.map((f) => f.type)
      : type.kind === "tuple"
        ? type.elements
        : type.kind === "vector"
          ? [type.element]
          : [];
  return [type.kind, ...children.flatMap(descriptorKinds)];
}

/**
 * Require the committed corpus to retain its type families and rejection policies.
 *
 * @param records - Parsed golden corpus.
 * @throws {Error} If a coverage family is absent.
 */
export function assertCorpusCoverage(records: CorpusRecord[]): void {
  assert(records.length > 400, "Corpus is empty or truncated");
  assert.equal(records.filter((r) => r.record === "header").length, 1, "Expected one header");
  assert.equal(records[0]?.record, "header", "Header must be first");
  const kinds = new Set(
    records.flatMap((r) => (r.record === "header" ? [] : descriptorKinds(r.type))),
  );
  for (const kind of [
    "boolean",
    "uint",
    "field",
    "secp256k1-base",
    "secp256k1-scalar",
    "bytes",
    "enum",
    "vector",
    "tuple",
    "struct",
  ]) {
    assert(kinds.has(kind), `Missing descriptor kind ${kind}`);
  }
  for (const category of Object.values(RejectCategory)) {
    assert(
      records.some(
        (r) => r.record === "deserialize" && "reject" in r.expect && r.expect.reject === category,
      ),
      `Missing rejection ${category}`,
    );
  }
  for (const provenance of ["circuit", "oracle", "twin", "production"]) {
    assert(
      records.some((r) => r.record !== "header" && r.provenance === provenance),
      `Missing provenance ${provenance}`,
    );
  }
  assert.equal(
    records.filter((r) => r.record === "sweep").length,
    400,
    "Seeded sweep coverage changed",
  );
}

/**
 * Compare the committed bytes with a fresh regeneration.
 *
 * @param committed - Corpus file contents.
 * @param regenerated - Fresh corpus file contents.
 * @throws {Error} If any byte differs.
 */
export function assertCorpusMatches(committed: string, regenerated: string): void {
  assert(committed.length > 0 && regenerated.length > 0, "Corpus comparison input is empty");
  assert.equal(
    committed,
    regenerated,
    "Corpus drift: regenerate after reviewing the layout change",
  );
}
