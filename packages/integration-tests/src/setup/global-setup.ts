// vitest globalSetup (see vitest.config.ts): runs the setup pipeline ONCE in
// the main process before ANY test file — including single-file selections —
// then hands the populated env accumulator to the flow-test workers via
// project.provide. A throw here aborts the whole run before any test starts.
// Without RUN_INTEGRATION_TESTS this is a no-op so plain `yarn test`
// stays offline (the flow suites then skip via describe.skipIf and see an
// empty injected env).

import type { TestProject } from "vitest/node";
import { buildBaseEnv } from "../e2e-env.ts";
import { testHeader } from "../output.ts";
import { waitForGo } from "../waitForGo.ts";
import {
  assertEnvironment,
  compileSignetContract,
  compileVaultContract,
  deploySignetContractStep,
  deployVaultContractStep,
  ensureErc20Deployed,
  ensureMpcJubjubPk,
  ensureMpcRootKey,
  ensureMpcSecp256k1Pubkey,
  ensureUserEvmAddress,
  ensureVaultEvmAddress,
  fundLocalEvmAccounts,
  printMpcServerConfig,
  resolveEvmChain,
} from "./steps.ts";

/** Step names match the original suite's test names — they are what the
 * operator greps for and what STEP_THROUGH prompts show. */
const STEPS: [name: string, run: (env: NodeJS.ProcessEnv) => void | Promise<void>][] = [
  ["environment: midnight stack reachable, compact on PATH, EVM_RPC_URL set", assertEnvironment],
  ["setup: resolve EVM chain id from EVM_RPC_URL", resolveEvmChain],
  ["setup: check/deploy ERC20 token on the EVM chain", ensureErc20Deployed],
  ["setup: check/derive MPC root key", ensureMpcRootKey],
  ["setup: check/derive MPC_JUBJUB_PK public key", ensureMpcJubjubPk],
  ["setup: check/derive MPC_SECP256K1_PUBKEY public key", ensureMpcSecp256k1Pubkey],
  ["setup: compile signet-contract contract with proving keys", compileSignetContract],
  ["setup: deploy signet-contract", deploySignetContractStep],
  ["setup: compile vault contract with proving keys", compileVaultContract],
  ["setup: deploy vault contract", deployVaultContractStep],
  ["setup: check/derive vault EVM address", ensureVaultEvmAddress],
  ["setup: check/derive user EVM address", ensureUserEvmAddress],
  ["setup: fund derived EVM accounts (local chain only)", fundLocalEvmAccounts],
  ["setup: print MPC server configuration", printMpcServerConfig],
];

export async function setup(project: TestProject): Promise<void> {
  if (!process.env.RUN_INTEGRATION_TESTS) return;

  const env = buildBaseEnv();
  for (const [index, [name, run]] of STEPS.entries()) {
    // Step-through mode pauses before each step after the first, exactly as
    // the flow files pause before each test (globalSetup runs in the main
    // process, where /dev/tty is just as reachable as in a worker).
    if (process.env.STEP_THROUGH && index > 0) {
      await waitForGo(index + 1, STEPS.length, name);
    }
    testHeader(index + 1, STEPS.length, name);
    await run(env);
  }

  // Hand the accumulator to the flow-test workers. provide() requires
  // structured-cloneable values, so keep only the string entries (which is
  // everything a ProcessEnv legitimately holds anyway).
  project.provide(
    "e2eEnv",
    Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
  );
}
