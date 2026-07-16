// The one indexer poll loop behind the golden-notification tests. State
// indexing lags finalization, so matching a registered signet notification
// means polling (gotcha #15) — this module owns only that plumbing; every
// assertion on the decoded notification stays in the test bodies.

import { getMidnightNodeConfig } from "@sig-net/midnight-contract-deploy";
import {
  decodeSignBidirectionalNotification,
  readSignBidirectionalNotificationIndexFromState,
  type RequestIdHex,
  type SignBidirectionalNotification,
} from "@sig-net/midnight";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { requireEnv } from "./e2e-env.ts";

/** What to poll the signet contract's notification registry for. */
export interface SignetNotificationPoll {
  /** The setup-populated env accumulator (signet address, node config). */
  env: NodeJS.ProcessEnv;
  /** The request id whose registry entry to wait for. */
  requestId: RequestIdHex;
  /** Human fragment for the timeout error, e.g. `for the withdraw request`. */
  description: string;
  /** Give-up timeout; default 60s. */
  timeoutMs?: number;
}

/**
 * Poll the signet contract's notification registry (ledger field 4, read the
 * way the MPC reads it — raw state by field position) until an entry for
 * `requestId` appears and decodes, or `timeoutMs` (default 60s) passes.
 *
 * @param options - The env, target request id, and patience.
 * @returns The decoded V1 notification.
 * @throws Error when no decodable entry for `requestId` is indexed in time.
 */
export async function pollSignetNotification(
  options: SignetNotificationPoll,
): Promise<SignBidirectionalNotification> {
  const signetAddress = requireEnv(options.env, "MIDNIGHT_SIGNET_CONTRACT_ADDRESS");
  const nodeConfig = getMidnightNodeConfig(options.env);
  const pdp = indexerPublicDataProvider({
    queryURL: nodeConfig.indexerUrl,
    subscriptionURL: nodeConfig.indexerWsUrl,
  });

  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await pdp.queryContractState(signetAddress);
    if (state?.data) {
      const registry = readSignBidirectionalNotificationIndexFromState(state.data);
      const record = registry.get(options.requestId);
      if (record !== undefined) {
        return decodeSignBidirectionalNotification(record);
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error(
    `no notification ${options.description} registered on ${signetAddress} within ${timeoutMs / 1000}s`,
  );
}
