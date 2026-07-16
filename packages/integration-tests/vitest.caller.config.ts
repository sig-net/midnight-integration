// The generic signet-caller e2e's own vitest config: same orchestration
// contract as vitest.config.ts (globalSetup first, no file parallelism), but
// with the CALLER pipeline as globalSetup — the EVM-free step list in
// src/setup/caller-global-setup.ts — and only the caller flow file in scope.
// A separate config (rather than a sixth FILE_ORDER entry) because the two
// pipelines differ: the vault globalSetup requires an EVM chain and deploys
// the vault; the caller pipeline must not.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./src/setup/caller-global-setup.ts",
    include: ["tests/signet-caller-e2e.test.ts"],
    fileParallelism: false,
  },
});
