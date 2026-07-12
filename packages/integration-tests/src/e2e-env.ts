// The env accumulator shared by globalSetup and the flow test files. This
// module MUST stay free of `vitest` imports: it is loaded by globalSetup in
// vitest's main process, where the worker-only test APIs are unavailable.
// The worker-side half (inject + hooks) lives in flow-hooks.ts.

import { loadRepoDotEnv } from "./env-file.ts";

/**
 * Environment accumulator: seeded from the repo-root `.env` file overlaid
 * with the real environment (which wins), then populated by the setup steps.
 * Each pipeline value lives under its canonical env-var name — presence
 * doubles as the step's skip signal, and the final printout is exactly this
 * map's pipeline keys. `process.env` itself is never mutated; the
 * accumulator is passed explicitly to config readers and subprocesses, and
 * handed to the test workers via vitest's provide/inject. EVM-side values
 * (`EVM_CHAIN_ID`, `ERC20_ADDRESS`) are NOT defaulted here — the
 * `resolveEvmChain` setup step fills them chain-aware from `EVM_RPC_URL`.
 */
export function buildBaseEnv(): NodeJS.ProcessEnv {
  return { ...loadRepoDotEnv(), ...process.env };
}

/**
 * The env keys the setup steps populate. Used only to build the "Minimal .env
 * block" printout — order here is purely cosmetic (execution order is fixed by
 * the setup-step sequence, not this array). Kept in derivation order so the
 * printed block reads like the flow that produced it.
 */
export const PIPELINE_KEYS = [
  "EVM_CHAIN_ID",
  "ERC20_ADDRESS",
  "MPC_ROOT_KEY",
  "MPC_JUBJUB_PK",
  "MPC_SECP256K1_PUBKEY",
  "MIDNIGHT_VAULT_CONTRACT_ADDRESS",
  "MIDNIGHT_SIGNET_CONTRACT_ADDRESS",
  "EVM_VAULT_ADDRESS",
  "EVM_USER_ADDRESS",
] as const;

/** Assert a prior setup step populated `name`, failing with a pointed message. */
export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is not set — did the step that derives it run (or is it missing from your .env)?`);
  }
  return value;
}
