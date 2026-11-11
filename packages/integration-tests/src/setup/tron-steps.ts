// Setup steps for the Tron leg of the signet-caller e2e (see
// caller-global-setup.ts and tests/signet-caller-tron-e2e.test.ts): deploy
// the SignetTronTarget Solidity contract on the local TRE and fund the
// caller's MPC-derived Tron account with TRX. Both are TRE-gated: the dev
// funder account only exists pre-funded on a throwaway local TRE chain.

import { readFileSync } from "node:fs";

import { deriveTronAddress, tronAddressFromBase58, tronAddressToBase58 } from "@sig-net/midnight";

import { CALLER_PATH_HEX } from "../constants.ts";
import { requireEnv } from "../e2e-env.ts";
import {
  assertLocalTre,
  deployTronContract,
  hasTronContractCode,
  topUpTrx,
  type TronContractArtifact,
  tronRpcUrl,
} from "../local-tron.ts";
import { logSkip } from "../output.ts";
import { runCommand } from "../subprocess.ts";
import { withTronBlockPusher } from "../tron-block-pusher.ts";

const MINUTE = 60_000;

/** The hardhat artifact `compile:evm` produces for the Tron target (abi + bytecode). */
const TRON_TARGET_ARTIFACT_URL = new URL(
  "../../artifacts/contracts/SignetTronTarget.sol/SignetTronTarget.json",
  import.meta.url,
);

/**
 * Compile (hardhat) and deploy the SignetTronTarget contract to the local
 * TRE, recording its base58 address as `TRON_TARGET_CONTRACT_ADDRESS`. Skips
 * when the env var is set AND the address still holds code: a
 * set-but-codeless address (TRE restarted, chain wiped) falls through to a
 * redeploy. Nothing is appended to `.env`: the fakenet does not need this
 * value, it reaches the test workers via the setup env accumulator.
 *
 * @param env - The suite's env accumulator.
 */
export async function deployTronTargetStep(env: NodeJS.ProcessEnv): Promise<void> {
  const rpc = tronRpcUrl(env);
  await assertLocalTre(rpc);
  const kept = env.TRON_TARGET_CONTRACT_ADDRESS;
  if (kept && (await hasTronContractCode(rpc, tronAddressFromBase58(kept)))) {
    logSkip("deploy SignetTronTarget", `TRON_TARGET_CONTRACT_ADDRESS is set with code (${kept})`);
    return;
  }
  if (kept) {
    console.log(`TRON_TARGET_CONTRACT_ADDRESS=${kept} holds no code (TRE wiped?): redeploying`);
  }
  // A no-op when the EVM target step already compiled both contracts.
  await runCommand(
    "yarn",
    ["workspace", "@midnight-integration/integration-tests", "compile:evm"],
    env,
    5 * MINUTE,
  );
  const artifact = JSON.parse(
    readFileSync(TRON_TARGET_ARTIFACT_URL, "utf8"),
  ) as TronContractArtifact;
  const address = await withTronBlockPusher(rpc, () => deployTronContract(rpc, artifact));
  env.TRON_TARGET_CONTRACT_ADDRESS = tronAddressToBase58(address);
  console.log(`deployed a fresh TRON_TARGET_CONTRACT_ADDRESS=${env.TRON_TARGET_CONTRACT_ADDRESS}`);
  console.log(
    ` ➜ the SignetTronTarget Solidity contract on the local TRE: the Tron e2e's call target`,
  );
  console.log(
    ` ➜ 💡 Set as TRON_TARGET_CONTRACT_ADDRESS in the environment to skip compile + deploy on the next run`,
  );
}

/**
 * The TRX balance the derived Tron account is topped up to, in sun (1000
 * TRX). A Tron request burns at most its fee limit (the e2e signs 50 TRX)
 * plus bandwidth, so this covers every request of many runs.
 */
const DERIVED_TRON_ACCOUNT_TARGET_SUN = 1_000_000_000n;

/**
 * Fund the caller's MPC-derived Tron account with TRX on the local TRE:
 * `deriveTronAddress(MPC_SECP256K1_PUBKEY, callerAddress, CALLER_PATH_HEX)`,
 * the owner the MPC signs the caller's Tron requests from. The first
 * transfer also creates the account, which a Tron transaction's owner must
 * be. Shortfall-only, so naturally idempotent (no skip env var). Runs AFTER
 * the caller deploy: the derivation needs the caller's address.
 *
 * @param env - The suite's env accumulator.
 */
export async function fundDerivedTronAccountStep(env: NodeJS.ProcessEnv): Promise<void> {
  const rpc = tronRpcUrl(env);
  await assertLocalTre(rpc);
  const derived = deriveTronAddress(
    requireEnv(env, "MPC_SECP256K1_PUBKEY"),
    requireEnv(env, "MIDNIGHT_CALLER_CONTRACT_ADDRESS"),
    CALLER_PATH_HEX,
  );
  const balance = await withTronBlockPusher(rpc, () =>
    topUpTrx(rpc, derived.bytes, DERIVED_TRON_ACCOUNT_TARGET_SUN),
  );
  console.log(`derived caller Tron account ${derived.base58} holds ${String(balance)} sun`);
  console.log(
    ` ➜ the account the MPC signs the caller's Tron requests from; it pays their energy and bandwidth`,
  );
}
