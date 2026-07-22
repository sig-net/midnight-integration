// Offline unit tests for the .env append-only writer — no stack, no env
// gate. The append-only guarantee (existing content survives byte-for-byte)
// is what lets the setup pipeline write to an operator's hand-edited .env.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendRepoDotEnv } from "../src/env-file.ts";

const scratchEnvFile = (): string => join(mkdtempSync(join(tmpdir(), "env-file-test-")), ".env");

describe("appendRepoDotEnv", () => {
  it("appends a provenance-commented block, preserving existing content byte-for-byte", () => {
    const file = scratchEnvFile();
    const existing = "# operator notes stay untouched\nKEEP_ME=1\n\n  WEIRD_SPACING = kept \n";
    writeFileSync(file, existing, "utf8");

    appendRepoDotEnv({ MPC_ROOT_KEY: "0xabc", MIDNIGHT_SIGNET_CONTRACT_ADDRESS: "0200aa" }, "test provenance", file);

    const written = readFileSync(file, "utf8");
    expect(written.startsWith(existing)).toBe(true);
    expect(written.slice(existing.length)).toBe(
      "\n# test provenance\nMPC_ROOT_KEY=0xabc\nMIDNIGHT_SIGNET_CONTRACT_ADDRESS=0200aa\n",
    );
  });

  it("creates the file when missing", () => {
    const file = scratchEnvFile();

    appendRepoDotEnv({ MPC_ROOT_KEY: "0xabc" }, "test provenance", file);

    expect(readFileSync(file, "utf8")).toBe("\n# test provenance\nMPC_ROOT_KEY=0xabc\n");
  });
});
