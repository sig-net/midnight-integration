import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CircuitSignatures } from "@midnight-ntwrk/compact-runtime";

/**
 * Read the verifier key a zk compile wrote for each provable circuit of a
 * compiled contract. Call it at module load, so a missing key fails the whole
 * test file with one message.
 *
 * @param circuitSignatures - The compiled contract's `circuitSignatures` export.
 * @param keysDirectory - The compiled contract's `keys/` directory, with a trailing slash.
 * @param zkCompile - The command that writes the keys, named when one is missing.
 * @returns Each provable circuit's verifier key, by circuit id.
 * @throws {Error} If a provable circuit's `.verifier` file is missing, naming `zkCompile`.
 */
export function readVerifierKeys(
  circuitSignatures: CircuitSignatures,
  keysDirectory: URL,
  zkCompile: string,
): ReadonlyMap<string, Uint8Array> {
  const keys = new Map<string, Uint8Array>();
  for (const [circuitId, signature] of Object.entries(circuitSignatures)) {
    if (!signature.provable) continue;
    const keyUrl = new URL(`${circuitId}.verifier`, keysDirectory);
    if (!existsSync(keyUrl)) {
      throw new Error(
        `${fileURLToPath(keyUrl)} is missing: this test needs the contract's verifier keys, so run \`${zkCompile}\` first`,
      );
    }
    keys.set(circuitId, readFileSync(keyUrl));
  }
  return keys;
}
