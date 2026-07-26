// vitest globalSetup for the generic signet-caller e2e (see
// vitest.config.ts). Runs the caller pipeline ONCE in the main process before
// the flow file, then hands the populated env accumulator to the worker via
// project.provide. A throw here aborts the whole run before any test starts.
// Without RUN_INTEGRATION_TESTS this is a no-op so plain `yarn test` stays
// offline.
//
// The pipeline serves BOTH flow files: the EVM-free base flow (whose request
// exists to be SIGNED, never broadcast) and the real-EVM flow (which
// broadcasts against the SignetEvmTarget contract on the local anvil). So on
// top of the stack checks, MPC keys, dust preflight, signet compile/deploy,
// fakenet hand-off and caller compile/deploy, it deploys the EVM target
// (early: fast and midnight-free) and funds the caller's derived EVM sender
// (last: the derivation needs the deployed caller's address).

import type { TestProject } from "vitest/node";
import { buildBaseEnv } from "../e2e-env.ts";
import { testHeader } from "../output.ts";
import { waitForGo } from "../waitForGo.ts";
import {
  assertCallerEnvironment,
  compileCallerContract,
  deployCallerContractStep,
  ensureCallerDeployerIdentity,
} from "./caller-steps.ts";
import {
  compileSignetContract,
  deploySignetContractStep,
  ensureMpcResponseKey,
  ensureMpcRootKey,
  ensureMpcSecp256k1Pubkey,
  persistFakenetHandoffToDotEnv,
  startFakenetResponder,
} from "./steps.ts";
import { deployEvmTargetStep, fundDerivedSenderStep } from "./evm-steps.ts";
import { ensureWalletSeeds, ensureWalletsFunded } from "./wallets.ts";

/** Step names are what the operator greps for and what STEP_THROUGH
 * prompts show. */
const STEPS: [name: string, run: (env: NodeJS.ProcessEnv) => void | Promise<void>][] = [
  ["environment: midnight stack reachable, compact on PATH", assertCallerEnvironment],
  ["setup: deploy the SignetEvmTarget EVM contract (hardhat compile + anvil deploy)", deployEvmTargetStep],
  ["setup: resolve/generate wallet seeds (root + deployer/invoker/mpc responder)", ensureWalletSeeds],
  ["setup: preflight root funding + fund the role wallets from root", ensureWalletsFunded],
  ["setup: check/derive MPC root key", ensureMpcRootKey],
  ["setup: check/derive MPC_SECP256K1_PUBKEY public key", ensureMpcSecp256k1Pubkey],
  ["setup: compile signet-contract contract with proving keys", compileSignetContract],
  ["setup: deploy signet-contract", deploySignetContractStep],
  ["setup: persist fakenet hand-off values to .env (append-only)", persistFakenetHandoffToDotEnv],
  ["setup: start the fakenet responder (docker compose)", startFakenetResponder],
  ["setup: compile caller contract with proving keys", compileCallerContract],
  ["setup: resolve caller deployer identity (gates initialise)", ensureCallerDeployerIdentity],
  ["setup: deploy caller contract", deployCallerContractStep],
  ["setup: check/derive MPC_RESPONSE_KEY for the caller contract", ensureMpcResponseKey],
  ["setup: fund the caller's derived EVM sender with ETH", fundDerivedSenderStep],
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

  // Hand the accumulator to the flow-test worker. provide() requires
  // structured-cloneable values, so keep only the string entries (which is
  // everything a ProcessEnv legitimately holds anyway).
  project.provide(
    "e2eEnv",
    Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
  );
}
