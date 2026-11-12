// The NODE binding of the signet signer to its compiled assets: the
// environment-specific half that @sig-net/midnight-signer deliberately
// does not ship (it assumes Node + fs + assets on disk). Consumers each
// declare their own; this is the deploy package's.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import {
  Contract,
  createSignetSignerPrivateState,
  type SignetSignerPrivateState,
} from "@sig-net/midnight-signer";

import { makeVacantCompiledContract } from "./plumbing/deploy.ts";

// The contract package's compiler output dir (contract/, keys/, zkir/) — the
// "zk config root" deploy tooling reads proving/verifier keys from. Resolved
// THROUGH THE PACKAGE SPECIFIER, never a workspace-relative path, so the same
// code works in-repo and from the npm tarball: the managed/ dir sits beside
// the entry module in both layouts (src/index.ts + src/managed in the repo,
// dist/index.js + dist/managed in the published package — the tarball ships
// prover keys, its build refuses to emit without them; an in-repo checkout
// needs `yarn compile:zk` output first). createRequire rather than
// `import.meta.resolve` because vitest's module runner does not implement
// the latter; the CJS resolver honors the same exports map.
/** Absolute path of the signet signer's `managed/` zk config root. */
export const signetSignerManagedPath = join(
  dirname(createRequire(import.meta.url).resolve("@sig-net/midnight-signer")),
  "managed",
);

/**
 * The signet-signer compact-js compiled-contract binding: generated module
 * (the contract declares no witnesses) and the compiled assets on disk.
 * Consumed by deploy tooling (and `findDeployedContract`, should a Node
 * client ever join the deployed contract).
 */
export const signetSignerCompiledContract = makeVacantCompiledContract<
  Contract<SignetSignerPrivateState>,
  SignetSignerPrivateState
>("signet-signer", Contract, signetSignerManagedPath);

// Re-exported so deploy-side callers get the private state builder from the
// same module as the binding it pairs with.
export { createSignetSignerPrivateState };
