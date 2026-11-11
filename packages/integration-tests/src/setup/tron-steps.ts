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

const TRON_TARGET_ARTIFACT_URL = new URL(
  "../../artifacts/contracts/SignetTronTarget.sol/SignetTronTarget.json",
  import.meta.url,
);

/**
 * @param env - The suite's env accumulator
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

const DERIVED_TRON_ACCOUNT_TARGET_SUN = 1_000_000_000n;

/**
 * @param env - The suite's env accumulator
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
