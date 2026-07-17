// Setup steps specific to the generic signet-caller e2e pipeline (see
// caller-global-setup.ts). Deliberately EVM-free: the caller's request is
// composed entirely from contract constants and exists to be SIGNED, never
// broadcast, so this pipeline needs no EVM chain, token, or funded derived
// accounts. The generic steps (MPC keys, dust preflight, signet
// compile/deploy, fakenet hand-off) live in steps.ts.

import { deployCaller } from "@midnight-protocol/caller-contract";
import { GENESIS_MINT_WALLET_SEED, getDeployConfig, getMidnightNodeConfig } from "@sig-net/midnight-contract-deploy";

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

  const deployConfig = getDeployConfig(env);
  // Never log the raw seed: on a deployed network it is a real funded wallet's
  // private key. Log only the non-secret signal (which wallet, which network).
  const usingGenesis = deployConfig.deployerSeed === GENESIS_MINT_WALLET_SEED;
  console.log(
    `deployer wallet: ${usingGenesis ? "local genesis mint wallet" : "custom DEPLOYER_SEED (redacted)"}` +
      ` on ${deployConfig.midnightNodeConfig.networkId}`,
  );
  console.log(` ➜ pays for contract deploys and drives the caller's circuits.`);
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
  console.log(` ➜ the minimal signet caller on Midnight — records signature requests and verifies the MPC's Schnorr responses`);
  console.log(` ➜ 💡 Set as MIDNIGHT_CALLER_CONTRACT_ADDRESS in the environment to skip compile + deploy on the next run`);
}
