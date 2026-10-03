import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

it.each([
  ["README.md", false],
  ["packages/signet-midnight/file.ts", false],
  ["packages/midnight-serde-conformance/file.ts", true],
  ["packages/midnight-serde-ts/file.ts", true],
  ["packages/midnight-serde-rs/file.rs", true],
] as const)("gates compiler conformance for %s", (path, expected) => {
  const directory = mkdtempSync(join(tmpdir(), "serde-ci-"));
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  try {
    git(["init", "--quiet"]);
    for (const name of ["midnight-serde-conformance", "midnight-serde-ts", "midnight-serde-rs"]) {
      mkdirSync(join(directory, "packages", name), { recursive: true });
      writeFileSync(join(directory, "packages", name, "fixture"), "base");
    }
    git(["add", "."]);
    const base = git(["write-tree"]);
    mkdirSync(join(directory, path, ".."), { recursive: true });
    writeFileSync(join(directory, path), "changed");
    git(["add", "."]);
    const head = git(["write-tree"]);
    const actual = execFileSync(
      "bash",
      [fileURLToPath(new URL("../ci-changes.sh", import.meta.url)), base, head],
      { cwd: directory, encoding: "utf8" },
    ).trim();
    expect(actual).toBe(`changed=${String(expected)}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
