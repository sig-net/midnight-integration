// Setup steps for the real-EVM leg of the signet-caller e2e (see
// caller-global-setup.ts and tests/signet-caller-evm-e2e.test.ts): deploy
// the SignetEvmTarget Solidity contract on the local anvil and fund the
// caller's MPC-derived sender with ETH. Both are 31337-gated: the dev funder
// account only exists pre-funded on a throwaway local chain.

import { readFileSync } from "node:fs";

import { deriveEvmAddress } from "@sig-net/midnight";

import { requireEnv } from "../e2e-env.ts";
import {
  assertLocalDevChain,
  deployEvmContract,
  evmRpcUrl,
  hasContractCode,
  topUpEth,
  type EvmContractArtifact,
} from "../local-evm.ts";
import { logSkip } from "../output.ts";
import { runCommand } from "../subprocess.ts";

const MINUTE = 60_000;

/** The hardhat artifact `compile:evm` produces (abi + bytecode). */
const TARGET_ARTIFACT_URL = new URL(
  "../../artifacts/contracts/SignetEvmTarget.sol/SignetEvmTarget.json",
  import.meta.url,
);

/**
 * The caller contract's fixed derivation path — every submit circuit uses
 * `pad(32, "caller-path")`, so ONE derived EVM sender serves all requests.
 * TS twin of the in-circuit literal (also mirrored by the flow files).
 */
export const CALLER_PATH = "caller-path";

/**
 * Compile (hardhat) and deploy the SignetEvmTarget contract to the local
 * anvil, recording the address as `EVM_TARGET_CONTRACT_ADDRESS`. Skips when
 * the env var is set AND the address still holds code — a set-but-codeless
 * address (anvil restarted, in-memory state wiped) falls through to a
 * redeploy. Nothing is appended to `.env`: the fakenet does not need this
 * value, it reaches the test workers via the setup env accumulator.
 *
 * @param env - The suite's env accumulator.
 */
export async function deployEvmTargetStep(env: NodeJS.ProcessEnv): Promise<void> {
  const rpc = evmRpcUrl(env);
  await assertLocalDevChain(rpc);
  const kept = env.EVM_TARGET_CONTRACT_ADDRESS;
  if (kept && (await hasContractCode(rpc, kept))) {
    logSkip("deploy SignetEvmTarget", `EVM_TARGET_CONTRACT_ADDRESS is set with code (${kept})`);
    return;
  }
  if (kept) {
    console.log(`EVM_TARGET_CONTRACT_ADDRESS=${kept} holds no code (anvil wiped?) — redeploying`);
  }
  await runCommand(
    "yarn",
    ["workspace", "@midnight-protocol/integration-tests", "compile:evm"],
    env,
    2 * MINUTE,
  );
  const artifact = JSON.parse(readFileSync(TARGET_ARTIFACT_URL, "utf8")) as EvmContractArtifact;
  env.EVM_TARGET_CONTRACT_ADDRESS = await deployEvmContract(rpc, artifact);
  console.log(`deployed a fresh EVM_TARGET_CONTRACT_ADDRESS=${env.EVM_TARGET_CONTRACT_ADDRESS}`);
  console.log(` ➜ the SignetEvmTarget Solidity contract on the local anvil — the real-EVM e2e's call target`);
  console.log(` ➜ 💡 Set as EVM_TARGET_CONTRACT_ADDRESS in the environment to skip compile + deploy on the next run`);
}

/**
 * Fund the caller's MPC-derived EVM sender with ETH on the local anvil:
 * `deriveEvmAddress(MPC_SECP256K1_PUBKEY, callerAddress, "caller-path")`,
 * topped up to 10 ETH (the contract-fixed worst case per request is
 * gasLimit x maxFeePerGas = 100000 x 30 gwei = 0.003 ETH). Shortfall-only,
 * so naturally idempotent — no skip env var. Runs AFTER the caller deploy:
 * the derivation needs the caller's address.
 *
 * @param env - The suite's env accumulator.
 */
export async function fundDerivedSenderStep(env: NodeJS.ProcessEnv): Promise<void> {
  const rpc = evmRpcUrl(env);
  await assertLocalDevChain(rpc);
  const derivedSender = deriveEvmAddress(
    requireEnv(env, "MPC_SECP256K1_PUBKEY"),
    requireEnv(env, "MIDNIGHT_CALLER_CONTRACT_ADDRESS"),
    CALLER_PATH,
  );
  const balance = await topUpEth(rpc, derivedSender);
  console.log(`derived caller EVM sender ${derivedSender} holds ${balance} wei`);
  console.log(` ➜ the account the MPC signs from for the caller's requests; it pays the broadcast gas`);
}
