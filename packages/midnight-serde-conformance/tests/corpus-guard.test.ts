// The anti-staleness guard: the committed corpus must equal a fresh
// regeneration from the compiled circuits + oracle + twin, byte for byte.
// Byte-comparing the WHOLE file (not record-by-record semantics) also pins
// ordering and formatting, so the committed file is provably the
// generator's output.

import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { assertCorpusCoverage, assertCorpusMatches } from "../src/corpus-check.ts";

const MANAGED_URL = new URL("../managed/contract/index.js", import.meta.url);
const CORPUS_URL = new URL("../corpus/serde-corpus.jsonl", import.meta.url);

describe("golden corpus", () => {
  it("exists and matches a regeneration from the live circuits byte-for-byte", async () => {
    expect(
      existsSync(MANAGED_URL),
      "fixture circuits missing: run `yarn compile` at the repo root first",
    ).toBe(true);
    expect(
      existsSync(CORPUS_URL),
      "corpus/serde-corpus.jsonl missing: run `yarn workspace @midnight-protocol/midnight-serde-conformance generate` and commit it",
    ).toBe(true);

    // Import lazily: corpus.ts imports the managed circuits at module load,
    // so a missing compile must hit the actionable assertion above first.
    const { buildCorpus, corpusText } = await import("../src/corpus.ts");
    const regenerated = corpusText(buildCorpus());
    const committed = readFileSync(CORPUS_URL, "utf8");

    assertCorpusCoverage(buildCorpus());
    expect(() => {
      assertCorpusMatches(committed, regenerated);
    }).not.toThrow();
  });

  it("rejects a planted byte mutation", async () => {
    const { buildCorpus, corpusText } = await import("../src/corpus.ts");
    const records = buildCorpus();
    const record = records.find((r) => r.record === "serialize" && r.packed.length > 0);
    expect(record).toBeDefined();
    if (record?.record !== "serialize") throw new Error("No serialisation record to mutate");
    const expected = corpusText(records);
    record.packed = (record.packed.startsWith("ff") ? "00" : "ff") + record.packed.slice(2);
    expect(() => {
      assertCorpusMatches(corpusText(records), expected);
    }).toThrow("Corpus drift");
  });

  it.each([
    "secp256k1-base",
    "secp256k1-scalar",
    "circuit",
    "oracle",
    "twin",
    "production",
    "uint-range",
    "enum-range",
    "field-range",
    "boolean-strict",
    "padding-nonzero",
    "short-buffer",
  ])("rejects missing %s coverage", async (missing) => {
    const { buildCorpus } = await import("../src/corpus.ts");
    const records = buildCorpus();
    const reduced = records.filter(
      (r) =>
        r.record === "header" ||
        (r.type.kind !== missing &&
          r.provenance !== missing &&
          !(
            r.record === "deserialize" &&
            "reject" in r.expect &&
            r.expect.reject.toString() === missing
          )),
    );
    expect(reduced.length).toBeLessThan(records.length);
    expect(() => {
      assertCorpusCoverage(reduced);
    }).toThrow();
  });
});
