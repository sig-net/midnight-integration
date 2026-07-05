// Minimal repo-root .env reader. Nothing else in the repo loads .env files
// (lib/cli read the provided env map directly), and vitest/node cannot be
// told to (--env-file is banned in NODE_OPTIONS) — so the suite loads it
// itself into its env accumulator. Deliberately minimal: KEY=VALUE lines,
// #-comments, optional single/double quotes; no interpolation, no multiline.

import { readFileSync } from "node:fs";
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
