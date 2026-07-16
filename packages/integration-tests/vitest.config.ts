// The pipeline's orchestration contract:
// - globalSetup runs the compile/deploy/derive pipeline ONCE in the main
//   process before any test file (also when a single file is selected), and
//   hands the env accumulator to the workers via provide/inject.
// - Flow files can NEVER run in parallel (shared chain state, one MPC
//   responder, EVM nonces and funds): fileParallelism false runs them one at
//   a time, and the sequencer pins the order — vitest's default sequencer
//   orders by results cache (failed/slowest first), not by name.
// - bail + --disable-console-intercept stay on the test:integration script.
import { basename } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

// Explicit flow order. New flow files must be appended here (see the
// "Registration points" note in this package's README); unknown files run
// last, name-ordered. happy-day runs first: it initializes the vault and
// cycles the funds later flows build on.
const FILE_ORDER = [
  "happy-day-e2e.test.ts",
  "deposit-withdrawal-failure-refund.test.ts",
  "deposit-claimant-not-caller.test.ts",
  "benchmark.test.ts",
  "false-claimer.test.ts",
];

const rank = (moduleId: string): number => {
  const index = FILE_ORDER.indexOf(basename(moduleId));
  return index === -1 ? FILE_ORDER.length : index;
};

class PipelineSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort(
      (a, b) => rank(a.moduleId) - rank(b.moduleId) || a.moduleId.localeCompare(b.moduleId),
    );
  }
}

export default defineConfig({
  test: {
    globalSetup: "./src/setup/global-setup.ts",
    // The generic signet-caller flow runs under its OWN config
    // (vitest.caller.config.ts) with the EVM-free caller pipeline as
    // globalSetup — excluded here so the vault pipeline never picks it up.
    exclude: [...configDefaults.exclude, "tests/signet-caller-e2e.test.ts"],
    fileParallelism: false,
    sequence: { sequencer: PipelineSequencer },
  },
});
