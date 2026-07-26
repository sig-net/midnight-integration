// Client of the fakenet's public /responses/{requestId} helper API: the
// fakenet observes each remote execution with debug_traceTransaction (the
// same RPC method the real MPC uses), caches the top call frame's raw
// return data per request id, and serves it here so clients need no trace
// RPC access of their own.
//
// The API is a CONVENIENCE, never an authority: the returned output is
// unauthenticated, and a caller must recompute the attestation digest from
// it and verify the MPC's posted signature before trusting it.

/** One observed remote-execution result as the fakenet serves it. */
export interface FakenetResponse {
  /** The request id, lowercase hex, no 0x prefix. */
  requestId: string;
  /** Whether the remote execution succeeded. */
  success: boolean;
  /**
   * The raw EVM return data of the mined call as 0x-prefixed hex (0x for a
   * plain transfer). null for a failed execution, which has no attested
   * output.
   */
  output: string | null;
  /** The remote transaction's hash. */
  txHash: string;
  /** When the fakenet observed the execution result (ISO 8601). */
  observedAt: string;
}

/** Base URL of the fakenet's helper API (`RESPONSES_API_PORT`, default 3040). */
export const fakenetResponsesUrl = (): string =>
  process.env.FAKENET_RESPONSES_URL ?? "http://localhost:3040";

/**
 * Fetch the observed execution result for one request id, retrying while the
 * fakenet has not cached it yet (404). The fakenet caches the output before
 * it posts the attestation on-chain, so once the attestation is visible the
 * entry exists and retries only cover scheduling slack.
 *
 * @param requestId - The request id, hex with or without 0x prefix.
 * @param timeoutMs - How long to keep retrying 404s before failing.
 * @returns The cached response.
 * @throws Error when the API stays unreachable or 404s past the deadline.
 */
export async function fetchFakenetResponse(
  requestId: string,
  timeoutMs = 30_000,
): Promise<FakenetResponse> {
  const url = `${fakenetResponsesUrl()}/responses/${requestId}`;
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "not attempted";
  do {
    let response: Response | undefined;
    try {
      response = await fetch(url);
    } catch (error) {
      lastFailure = `fetch failed: ${String(error)} (is the fakenet running with its responses API?)`;
    }
    if (response) {
      if (response.ok) {
        return (await response.json()) as FakenetResponse;
      }
      lastFailure = `HTTP ${response.status}: ${await response.text()}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  throw new Error(`no fakenet response for ${requestId} within ${timeoutMs}ms (${lastFailure}) at ${url}`);
}
