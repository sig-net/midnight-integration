// The fakenet's output cache as the real-EVM flow reads it. The responder
// simulates the MPC's output storage bucket (its `OUTPUT_CACHE_PORT`, 3040
// in the compose stack, under the prefix `v1/fakenet`) and writes each
// attestation's exact bytes there BEFORE posting, so the flow reads them
// through the same `MpcOutputCacheReader` a client points at a real MPC's
// bucket. What it returns is UNTRUSTED until the attestation signature
// verifies over it.

import type { MpcOutputCacheReader, RequestIdHex } from "@sig-net/midnight";

/**
 * The fakenet's output cache URL down to its object prefix:
 * `MPC_OUTPUT_CACHE_URL`, defaulting to the compose stack's host mapping.
 *
 * @param env - The suite's env accumulator.
 * @returns The cache URL an `MpcOutputCacheReader` takes as `cacheUrl`.
 */
export function mpcOutputCacheUrl(env: NodeJS.ProcessEnv): string {
  return env.MPC_OUTPUT_CACHE_URL ?? "http://localhost:3040/v1/fakenet";
}

/**
 * Fetch the attested output the fakenet cached for one request, retrying
 * ONLY while the object is not written yet or the cache is unreachable.
 * The fakenet writes the object before it posts the attestation on chain,
 * so once the attestation is visible the object exists and retries only
 * cover scheduling slack. Any other HTTP status is a real fault the reader
 * throws, and that throw propagates at once.
 *
 * @param reader - The reader over the fakenet's cache.
 * @param requestId - The request whose attested output to fetch.
 * @param timeoutMs - How long to keep retrying a missing object or an
 *   unreachable cache before failing.
 * @returns The cached bytes, verbatim.
 * @throws {Error} When the object stays missing or the cache unreachable past
 *   the deadline, or immediately on any other cache fault.
 */
export async function fetchAttestedOutput(
  reader: MpcOutputCacheReader,
  requestId: RequestIdHex,
  timeoutMs = 30_000,
): Promise<Uint8Array> {
  const deadline = Date.now() + timeoutMs;
  let lastFailure: string;
  do {
    try {
      const cached = await reader.fetchSerializedOutput(requestId);
      if (cached !== undefined) {
        return cached;
      }
      lastFailure = "no object yet";
    } catch (error) {
      if (!(error instanceof TypeError)) {
        throw error;
      }
      // fetch rejects with a TypeError when the cache cannot be reached.
      lastFailure = `fetch failed: ${error.message} (is the fakenet running with its output cache?)`;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  throw new Error(
    `no cached output for ${requestId} within ${String(timeoutMs)}ms (${lastFailure}) at ${reader.objectUrl(requestId)}`,
  );
}
