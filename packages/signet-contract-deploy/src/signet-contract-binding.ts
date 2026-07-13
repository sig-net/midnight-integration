// The NODE binding of the signet contract to its compiled assets — the
// environment-specific half that @sig-net/midnight-contract deliberately
// does not ship (it assumes Node + fs + assets on disk). Consumers each
// declare their own; this is the monorepo operator's.

import { fileURLToPath } from "node:url";

import { makeVacantCompiledContract } from "@midnight-erc20-vault/lib";
import {
  Contract,
  createSignetContractPrivateState,
  type SignetContractPrivateState,
} from "@sig-net/midnight-contract";

// The contract package's compiler output dir (contract/, keys/, zkir/) — the
// "zk config root" deploy tooling reads proving/verifier keys from. Resolved
// RELATIVE TO THE MONOREPO LAYOUT (sibling package, raw source tree): this
// package is private and always runs in-repo via tsx/vitest, and deploying
// needs the full `yarn compile:zk` output (prover keys included), which only
// exists there — the published tarball ships verifier keys only.
export const signetContractManagedPath = fileURLToPath(
  new URL("../../signet-contract/src/managed", import.meta.url),
);

/**
 * The signet-contract compact-js compiled-contract binding: generated module
 * (the contract declares no witnesses) and the compiled assets on disk.
 * Consumed by deploy tooling (and `findDeployedContract`, should an in-repo
 * client ever join the deployed contract).
 */
export const signetContractCompiledContract = makeVacantCompiledContract<
  Contract<SignetContractPrivateState>,
  SignetContractPrivateState
>(
  "signet-contract",
  Contract,
  signetContractManagedPath,
);

// Re-exported so deploy-side callers get the private state builder from the
// same module as the binding it pairs with.
export { createSignetContractPrivateState };
