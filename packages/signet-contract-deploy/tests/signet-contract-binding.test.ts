// signetContractManagedPath: the package-specifier route to the contract's
// compiled assets. Locks the invariant the npm tarball relies on: the
// managed/ dir is resolved THROUGH @sig-net/midnight-contract's exports as a
// sibling of its entry module (src/index.ts in the repo, dist/index.js from
// the tarball), never via a workspace-relative path.

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { signetContractManagedPath } from "../src/index.ts";

describe("signetContractManagedPath", () => {
  it("is the managed/ sibling of the contract package's entry module", () => {
    expect(basename(signetContractManagedPath)).toBe("managed");
    const entryDir = dirname(signetContractManagedPath);
    const hasEntrySibling = existsSync(join(entryDir, "index.ts")) || existsSync(join(entryDir, "index.js"));
    expect(hasEntrySibling).toBe(true);
  });

  it("points at real compiler output (run `yarn compile` first)", () => {
    expect(existsSync(join(signetContractManagedPath, "contract"))).toBe(true);
  });
});
