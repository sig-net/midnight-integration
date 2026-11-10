// The NODE binding of the signet responder to its compiled assets: the
// environment-specific half @sig-net/midnight-responder does not ship, the
// responder's counterpart of signet-signer-binding.ts.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import {
  Contract,
  createSignetResponderPrivateState,
  type SignetResponderPrivateState,
} from "@sig-net/midnight-responder";

import { makeVacantCompiledContract } from "./plumbing/deploy.ts";

// Resolved through the package specifier, as signetSignerManagedPath is:
// the managed/ dir sits beside the entry module both in the repo
// (src/index.ts + src/managed, keys from `yarn compile:signet-responder:zk`)
// and in the npm tarball (dist/index.js + dist/managed, which always carries
// the keys).
/** Absolute path of the signet responder's `managed/` zk config root. */
export const signetResponderManagedPath = join(
  dirname(createRequire(import.meta.url).resolve("@sig-net/midnight-responder")),
  "managed",
);

/**
 * The signet-responder compact-js compiled-contract binding: generated module
 * (the contract declares no witnesses) and the compiled assets on disk.
 * Consumed by deploy tooling.
 */
export const signetResponderCompiledContract = makeVacantCompiledContract<
  Contract<SignetResponderPrivateState>,
  SignetResponderPrivateState
>("signet-responder", Contract, signetResponderManagedPath);

// Re-exported so deploy-side callers get the private state builder from the
// same module as the binding it pairs with.
export { createSignetResponderPrivateState };
