// The one indexer poll loop behind every golden-event test. Event indexing
// lags finalization, so matching an emitted signet event means polling
// (gotcha #15) — this module owns only that plumbing; which decoder to use
// and every assertion on the decoded event stay in the test bodies.

import { getMidnightNodeConfig } from "@midnight-erc20-vault/lib";
import { eventNameTag, hexToBytes } from "@midnight-erc20-vault/signet-midnight";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { requireEnv } from "./e2e-env.ts";

export interface SignetEventPoll<T> {
  env: NodeJS.ProcessEnv;
  /** Event-name tag to filter on (e.g. SIGN_BIDIRECTIONAL_EVENT_TAG). */
  tag: string;
  decode: (payload: Uint8Array) => T;
  match: (decoded: T) => boolean;
  /** Human fragment for the timeout error, e.g. `for request ${id}`. */
  description: string;
  timeoutMs?: number;
}

export interface SignetEventPollResult<T> {
  decoded: T;
  /** Capture as the unit fixture if the byte layout ever drifts. */
  rawPayloadHex: string;
  /** How many events matched in the final (successful) query round. */
  observedCount: number;
}

/**
 * Poll the signet contract's indexed Misc events until one with `tag`
 * decodes to something `match` accepts, or `timeoutMs` (default 60s) passes.
 * Scans every event per round (no early break) so `observedCount` reports
 * how many matched — the at-most-once assertions need it; when several
 * match, the LAST one in indexer order is returned.
 */
export async function pollDecodedSignetEvent<T>(options: SignetEventPoll<T>): Promise<SignetEventPollResult<T>> {
  const signetAddress = requireEnv(options.env, "MIDNIGHT_SIGNET_CONTRACT_ADDRESS");
  const nodeConfig = getMidnightNodeConfig(options.env);
  const pdp = indexerPublicDataProvider({
    queryURL: nodeConfig.indexerUrl,
    subscriptionURL: nodeConfig.indexerWsUrl,
  });

  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  let decoded: T | undefined;
  let rawPayloadHex: string | undefined;
  let observedCount = 0;
  while (Date.now() < deadline && decoded === undefined) {
    const events = await pdp.queryContractEvents({
      contractAddress: signetAddress,
      types: ["Misc"],
    });
    observedCount = 0;
    for (const event of events) {
      if (event.eventType !== "Misc") continue;
      if (eventNameTag(event.name) !== options.tag) continue;
      const candidate = options.decode(hexToBytes(event.payload));
      if (!options.match(candidate)) continue;
      observedCount += 1;
      decoded = candidate;
      rawPayloadHex = event.payload;
    }
    if (decoded === undefined) await new Promise((r) => setTimeout(r, 1000));
  }

  if (decoded === undefined || rawPayloadHex === undefined) {
    throw new Error(
      `no Misc "${options.tag}" event ${options.description} indexed on ${signetAddress} within ${timeoutMs / 1000}s`,
    );
  }
  return { decoded, rawPayloadHex, observedCount };
}
