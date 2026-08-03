// The anti-staleness guard: the committed corpus must equal a fresh
// regeneration from the compiled circuits + oracle + twin, byte for byte.
// Byte-comparing the WHOLE file (not record-by-record semantics) also pins
// ordering and formatting, so the committed artifact is provably the
// generator's output.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MANAGED_URL = new URL('../managed/contract/index.js', import.meta.url);
const CORPUS_URL = new URL('../corpus/serde-corpus.jsonl', import.meta.url);

describe('golden corpus', () => {
  it('exists and matches a regeneration from the live circuits byte-for-byte', async () => {
    expect(
      existsSync(MANAGED_URL),
      "fixture circuits missing: run `yarn compile` at the repo root first"
    ).toBe(true);
    expect(
      existsSync(CORPUS_URL),
      'corpus/serde-corpus.jsonl missing: run `yarn workspace @midnight-protocol/midnight-serde-conformance generate` and commit it'
    ).toBe(true);

    // Import lazily: corpus.ts imports the managed circuits at module load,
    // so a missing compile must hit the actionable assertion above first.
    const { buildCorpus, corpusText } = await import('../src/corpus.ts');
    const regenerated = corpusText(buildCorpus());
    const committed = readFileSync(CORPUS_URL, 'utf8');

    if (committed !== regenerated) {
      const committedLines = committed.split('\n');
      const regeneratedLines = regenerated.split('\n');
      let line = 0;
      while (
        line < Math.max(committedLines.length, regeneratedLines.length) &&
        committedLines[line] === regeneratedLines[line]
      ) {
        line++;
      }
      throw new Error(
        `${fileURLToPath(CORPUS_URL)} is stale at line ${line + 1}:\n` +
          `  committed:   ${committedLines[line] ?? '<missing>'}\n` +
          `  regenerated: ${regeneratedLines[line] ?? '<missing>'}\n` +
          'The corpus is derived from serde-fixtures.compact + the compiled circuits + the twin. ' +
          'Run `yarn workspace @midnight-protocol/midnight-serde-conformance generate` and commit ' +
          'the diff. Treat any diff you did not intend as a layout regression.'
      );
    }
  });
});
