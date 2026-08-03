// The one indexer poll loop behind the golden-notification tests. Event
// indexing lags finalization, so matching an emitted signet notification
// means polling (gotcha #15). This module owns only that plumbing. Every
// assertion on the decoded notification stays in the test bodies.

import { getMidnightNodeConfig } from "@sig-net/midnight-contract-deploy";
import {
  decodeSignBidirectionalEventNotificationPayload,
  decodeSignBidirectionalNotification,
  signetEventSourceFromPublicDataProvider,
  stripHexPrefix,
  SignetEventName,
  type SignBidirectionalNotification,
} from "@sig-net/midnight";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { requireEnv } from "./e2e-env.ts";

/** What to poll the signet contract's notification events for. */
export interface SignetNotificationPoll {
  /** The setup-populated env accumulator (signet address, node config). */
  env: NodeJS.ProcessEnv;
  /** The caller contract a matching notification must name (any hex form). */
  callerAddress: string;
  /**
   * The request-map path a matching notification must carry, e.g. `[4]` for
   * the caller's flat field-4 map. The notification events carry no request
   * id, so caller + path is the match key.
   */
  requestsPath: readonly number[];
  /** Human fragment for the timeout error, e.g. `for the withdraw request`. */
  description: string;
  /** Give-up timeout; default 60s. */
  timeoutMs?: number;
}

/**
 * Poll the signet contract's emitted Misc events (read the way the MPC reads
 * them: through the indexer's contract-events query and the shared event
 * decoders) until a SignBidirectionalEvent notification naming
 * `callerAddress` with `requestsPath` appears and decodes, or `timeoutMs`
 * (default 60s) passes. Undecodable events are skipped: the poll is a
 * matcher, not a validator.
 *
 * @param options - The env, expected caller pointer, and patience.
 * @returns The decoded V1 notification.
 * @throws Error when no matching decodable event is indexed in time.
 */
export async function pollSignetNotification(
  options: SignetNotificationPoll,
): Promise<SignBidirectionalNotification> {
  const signetAddress = requireEnv(options.env, "MIDNIGHT_SIGNET_CONTRACT_ADDRESS");
  const nodeConfig = getMidnightNodeConfig(options.env);
  const eventSource = signetEventSourceFromPublicDataProvider(
    indexerPublicDataProvider({
      queryURL: nodeConfig.indexerUrl,
      subscriptionURL: nodeConfig.indexerWsUrl,
    }),
  );
  const expectedCaller = stripHexPrefix(options.callerAddress).toLowerCase();
  const expectedPath = [...options.requestsPath];

  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await eventSource.querySignetEvents(signetAddress);
    for (const event of events) {
      if (event.name !== SignetEventName.SignBidirectionalEvent) continue;
      let decoded: SignBidirectionalNotification;
      try {
        decoded = decodeSignBidirectionalNotification(
          decodeSignBidirectionalEventNotificationPayload(event.payload),
        );
      } catch {
        continue;
      }
      if (
        decoded.callerAddress === expectedCaller &&
        decoded.requestsPath.length === expectedPath.length &&
        decoded.requestsPath.every((entry, i) => entry === expectedPath[i])
      ) {
        return decoded;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error(
    `no notification event ${options.description} emitted on ${signetAddress} within ${timeoutMs / 1000}s`,
  );
}
