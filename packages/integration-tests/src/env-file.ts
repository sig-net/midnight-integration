// Minimal repo-root .env reader + append-only writer. Nothing else in the
// repo loads .env files (lib/cli read the provided env map directly), and
// vitest/node cannot be told to (--env-file is banned in NODE_OPTIONS) — so
// the suite loads it itself into its env accumulator. Deliberately minimal:
// KEY=VALUE lines, #-comments, optional single/double quotes; no
// interpolation, no multiline. Writing is append-only BY DESIGN: the file is
// hand-edited by operators, and an append can never corrupt or reorder what
// they wrote.

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "./subprocess.ts";

/**
 * Read the repo-root `.env` file into a plain map. Missing file yields an
 * empty map. Callers should overlay `process.env` on top so the real
 * environment always wins over the file.
 *
 * @returns The parsed KEY=VALUE pairs (empty values skipped).
 */
export function loadRepoDotEnv(): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(join(REPO_ROOT, ".env"), "utf8");
  } catch {
    return {};
  }

  const parsed: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || line.trimStart().startsWith("#")) {
      continue;
    }
    const [, key, rawValue] = match;
    const value = rawValue.replace(/^(["'])(.*)\1$/, "$2");
    if (value !== "") {
      parsed[key] = value;
    }
  }
  return parsed;
}

/**
 * Append `KEY=value` lines to the repo-root `.env` under a one-line `#`
 * provenance comment, creating the file when missing. STRICTLY append-only:
 * existing lines are never read, reordered, or rewritten, so this call
 * cannot corrupt a hand-edited file. Presence and conflict checks are the
 * CALLER's job (via {@link loadRepoDotEnv}) — never append a key the file
 * already holds: duplicate-key precedence differs between consumers (this
 * reader takes the last occurrence; docker compose applies its own rule), so
 * a duplicate is a latent inconsistency, not an override.
 *
 * @param entries - The KEY=value pairs to append, in iteration order.
 * @param provenance - One-line note of who wrote the block and why.
 * @param filePath - The env file to append to; defaults to the repo-root
 *   `.env` (overridable so tests can target a scratch file).
 */
export function appendRepoDotEnv(
  entries: Record<string, string>,
  provenance: string,
  filePath: string = join(REPO_ROOT, ".env"),
): void {
  const lines = Object.entries(entries).map(([key, value]) => `${key}=${value}`);
  appendFileSync(filePath, `\n# ${provenance}\n${lines.join("\n")}\n`, "utf8");
}
