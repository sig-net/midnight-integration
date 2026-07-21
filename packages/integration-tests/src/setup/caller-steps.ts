// Setup steps specific to the generic signet-caller e2e pipeline (see
// caller-global-setup.ts). Deliberately EVM-free: the caller's request is
// composed entirely from contract constants and exists to be SIGNED, never
// broadcast, so this pipeline needs no EVM chain, token, or funded derived
// accounts. The generic steps (MPC keys, dust preflight, signet
// compile/deploy, fakenet hand-off) live in steps.ts.

import { deployCaller } from "@midnight-protocol/caller-contract";
import { getMidnightNodeConfig } from "@sig-net/midnight-contract-deploy";

import { requireEnv } from "../e2e-env.ts";
import { logSkip } from "../output.ts";
import { assertCommandAvailable, assertHttpReachable } from "../preflight.ts";
import { runRootScript } from "../subprocess.ts";
import { retryDeployWhileDustGenerates, trustsPrebuiltZkKeys } from "./steps.ts";

const MINUTE = 60_000;

/**
 * Assert the Midnight stack is reachable and the compact CLI is on PATH.
 * Deliberately checks no EVM endpoint — this pipeline has no EVM
 * requirement.
 *
 * @param env - The suite's env accumulator.
 * @throws If a stack endpoint is unreachable or `compact` is missing.
 */
export async function assertCallerEnvironment(env: NodeJS.ProcessEnv): Promise<void> {
  const nodeConfig = getMidnightNodeConfig(env);
  await assertHttpReachable("midnight node", new URL("/health", nodeConfig.nodeUrl).href);
  await assertHttpReachable("indexer", nodeConfig.indexerUrl);
  await assertHttpReachable("proof server", nodeConfig.proofServerUrl);
  await assertCommandAvailable("compact", ["--version"]);
  console.log(`targeting the ${nodeConfig.networkId} network at ${nodeConfig.nodeUrl}`);
}

/**
 * zk-compile the caller contract (proving keys) unless a kept contract
 * address or the CI key cache makes the compile unnecessary.
 *
 * @param env - The suite's env accumulator.
 */
export async function compileCallerContract(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.MIDNIGHT_CALLER_CONTRACT_ADDRESS) {
    logSkip("compile:caller-contract:zk", `MIDNIGHT_CALLER_CONTRACT_ADDRESS is set (${env.MIDNIGHT_CALLER_CONTRACT_ADDRESS})`);
    return;
  }
  if (trustsPrebuiltZkKeys(env, "packages/caller-contract/src/managed/signet-caller/keys")) {
    logSkip(
      "compile:caller-contract:zk",
      "TRUST_PREBUILT_ZK_KEYS=1 and prover keys are present (restored from a cache keyed on the contract sources)",
    );
    return;
  }
  await runRootScript("compile:caller-contract:zk", env, 14 * MINUTE);
}

/**
 * Resolve the caller deployer's identity secret: the commitment sealed by
 * the caller's constructor gates its initialise circuit, and the flow's
 * initialise leg answers the deployerSecretKey witness with this value.
 * Defaults to the deployer wallet seed (the same convention the erc20-vault
 * example uses), so no fresh material is minted.
 *
 * @param env - The suite's env accumulator.
 */
export function ensureCallerDeployerIdentity(env: NodeJS.ProcessEnv): void {
  if (env.CALLER_DEPLOYER_SECRET_KEY) {
    logSkip("resolve caller deployer identity", "CALLER_DEPLOYER_SECRET_KEY is set");
    return;
  }
  env.CALLER_DEPLOYER_SECRET_KEY = requireEnv(env, "DEPLOYER_SEED");
  console.log("defaulted CALLER_DEPLOYER_SECRET_KEY to the deployer wallet seed (initialise is deployer-gated)");
  console.log(" ➜ its commitment is sealed by the caller's constructor; only its holder may pin the response key");
}

/**
 * Deploy the caller contract (unless a kept address skips it), retrying while
 * deployer dust generates on a young chain, and record the address in the
 * accumulator under `MIDNIGHT_CALLER_CONTRACT_ADDRESS`.
 *
 * @param env - The suite's env accumulator.
 */
export async function deployCallerContractStep(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.MIDNIGHT_CALLER_CONTRACT_ADDRESS) {
    logSkip("deploy:caller-contract", `MIDNIGHT_CALLER_CONTRACT_ADDRESS is set (${env.MIDNIGHT_CALLER_CONTRACT_ADDRESS})`);
    return;
  }
  const { contractAddress } = await retryDeployWhileDustGenerates("deploy:caller-contract", () => deployCaller(env));
  env.MIDNIGHT_CALLER_CONTRACT_ADDRESS = contractAddress;
  console.log(`deployed a fresh MIDNIGHT_CALLER_CONTRACT_ADDRESS=${contractAddress}`);
  console.log(` ➜ the minimal signet caller on Midnight — records signature requests and verifies the MPC's ECDSA responses`);
  console.log(` ➜ 💡 Set as MIDNIGHT_CALLER_CONTRACT_ADDRESS in the environment to skip compile + deploy on the next run`);
}
