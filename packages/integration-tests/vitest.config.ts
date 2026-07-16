// The suite's orchestration contract:
// - globalSetup runs the caller pipeline (src/setup/caller-global-setup.ts)
//   ONCE in the main process before any test file — a no-op without
//   RUN_INTEGRATION_TESTS, so plain `yarn test` stays offline — and hands the
//   env accumulator to the workers via provide/inject.
// - fileParallelism false: the flow file drives shared chain state (one MPC
//   responder, one deployer wallet), so files run one at a time.
// - bail + --disable-console-intercept stay on the test:integration script.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./src/setup/caller-global-setup.ts",
    fileParallelism: false,
  },
});
