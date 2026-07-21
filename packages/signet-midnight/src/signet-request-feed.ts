// The MPC's single entry point for discovering signature requests: poll the
// central signet contract's notification registry (ledger field 4), resolve
// each notification to an AUTHENTICATED request read from the named caller's
// own ledger, and yield only the ones that pass the membership check. The
// registry is append-only with no on-ledger cursor, so the feed's in-memory
// `yielded` set is the diff cursor: every poll enumerates the registry and
// serves what it has not served before.
//
// The requester allow-list is an OPTIONAL policy filter here (drop requests
// from contracts you choose not to serve), never a security requirement and
// never the discovery mechanism — attribution comes from the resolver's
// authenticated read (see signet-request-resolver.ts and
// knowledge-base/caller-attribution.md).

import {
  decodeSignBidirectionalNotification,
  readSignBidirectionalNotificationIndexFromState,
} from "./signet-contract-state-reader.ts";
import {
  SignetRequestResolver,
  type ResolvedSignetRequest,
} from "./signet-request-resolver.ts";
import type { SignetPublicStateSource } from "./signet-request-response-reader.ts";
import { stripHexPrefix, type RequestIdHex } from "./signet-requests.ts";

/** Default gap between poll cycles of {@link SignetRequestFeed.requests}. */
export const DEFAULT_FEED_POLL_INTERVAL_MS = 3000;

/** Everything a {@link SignetRequestFeed} needs. */
export interface SignetRequestFeedConfig {
  /** Address of the central signet contract whose notification registry to poll. */
  readonly signetContractAddress: string;
  /**
   * Source of raw contract state for BOTH the signet contract's registry and
   * the requester ledgers the resolver authenticates against — a full
   * `indexerPublicDataProvider` is assignable.
   */
  readonly source: SignetPublicStateSource;
  /**
   * Optional policy allow-list of requester contract addresses to serve
   * (matched case- and `0x`-prefix-insensitively). Omit to serve every
   * requester the resolver can authenticate. NOT a security control.
   */
  readonly allowContracts?: Iterable<string>;
  /** Poll cadence for {@link SignetRequestFeed.requests}; default {@link DEFAULT_FEED_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number;
}

/**
 * Resolve after `ms`, or immediately once `signal` aborts. Used to space out
 * polls without wedging a shutdown.
 *
 * @param ms - Milliseconds to wait.
 * @param signal - Abort to resolve early.
 * @returns A promise that settles after the delay or the abort.
 */
export function sleepUnlessAborted(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Canonical form for comparing contract addresses: no `0x`, lowercase. */
function normalizeAddress(address: string): string {
  return stripHexPrefix(address).toLowerCase();
}

/**
 * The registry-polling request feed. Reads the signet contract's notification
 * registry (discovery) and hands each notification to a
 * {@link SignetRequestResolver} (authentication), yielding only notifications
 * that resolve to a real, member request. Dedupes by request id across its
 * lifetime, so a re-registered notification is not re-yielded; call
 * {@link forget} to re-arm a request whose downstream processing failed.
 */
export class SignetRequestFeed {
  private readonly signetContractAddress: string;
  private readonly source: SignetPublicStateSource;
  private readonly resolver: SignetRequestResolver;
  private readonly allowContracts?: Set<string>;
  private readonly pollIntervalMs: number;

  // Request ids already yielded. NOT the security boundary (the resolver is) —
  // just an at-most-once gate so one request is not processed twice.
  private readonly yielded = new Set<RequestIdHex>();

  /**
   * @param config - The signet contract, state source, and optional policy
   *   allow-list.
   */
  constructor(config: SignetRequestFeedConfig) {
    this.signetContractAddress = config.signetContractAddress;
    this.source = config.source;
    this.resolver = new SignetRequestResolver({ source: config.source });
    this.allowContracts = config.allowContracts
      ? new Set(Array.from(config.allowContracts, normalizeAddress))
      : undefined;
    this.pollIntervalMs =
      config.pollIntervalMs ?? DEFAULT_FEED_POLL_INTERVAL_MS;
  }

  /** Whether the policy allow-list admits `callerAddress` (always true when unset). */
  private allowed(callerAddress: string): boolean {
    return (
      this.allowContracts === undefined ||
      this.allowContracts.has(normalizeAddress(callerAddress))
    );
  }

  /**
   * One-shot: every currently-registered notification that decodes, is
   * admitted by the allow-list, not already yielded, and resolves to an
   * authenticated member request. Registry enumeration has no meaningful
   * on-ledger order, so entries are processed in ascending request-id-hex
   * order — a stable, deterministic sequence. Forged / not-yet-indexed /
   * wrong-field notifications resolve to nothing and are dropped WITHOUT
   * being marked yielded, so a genuine request whose ledger write has not
   * indexed yet is retried next cycle; undecodable or unsupported-version
   * records are likewise skipped (and logged) without being marked.
   *
   * Dedupe and resolution key off the request id of the registry entry's map
   * key (the V1 payload no longer carries one). The key is caller-supplied,
   * so it confers no authority — the resolver's membership check against the
   * named caller's own ledger is what authenticates it.
   *
   * @returns The newly-authenticated requests this cycle.
   * @throws Error if the signet contract has no readable state at the
   *   configured address (wrong address or not yet deployed/indexed).
   */
  async poll(): Promise<ResolvedSignetRequest[]> {
    const state = await this.source.queryContractState(
      this.signetContractAddress,
    );
    if (!state?.data) {
      throw new Error(
        `No contract state at signet contract ${this.signetContractAddress} ` +
          `— wrong address, or not yet deployed/indexed`,
      );
    }
    const registry = readSignBidirectionalNotificationIndexFromState(
      state.data,
    );
    const out: ResolvedSignetRequest[] = [];
    for (const [requestId, record] of [...registry.entries()].sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    )) {
      let notification;
      try {
        notification = decodeSignBidirectionalNotification(record);
      } catch (error) {
        console.warn(
          `SignetRequestFeed: skipping undecodable notification ` +
            `registered under ${requestId}: ${String(error)}`,
        );
        continue;
      }
      if (this.yielded.has(requestId)) continue;
      if (!this.allowed(notification.callerAddress)) continue;
      const resolved = await this.resolver.resolve(requestId, notification);
      if (resolved === undefined) continue;
      this.yielded.add(requestId);
      out.push(resolved);
    }
    return out;
  }

  /**
   * Re-arm `requestId` for redelivery on the next {@link poll} / {@link requests}
   * cycle — call when downstream processing of a yielded request failed, so it
   * is retried (mirrors the MPC's delete-on-failure of its processed set).
   *
   * @param requestId - The request id to allow through again.
   */
  forget(requestId: RequestIdHex): void {
    this.yielded.delete(requestId);
  }

  /**
   * Live stream: poll + sleep, yielding each authenticated request exactly once
   * (subject to {@link forget}), until `opts.signal` aborts. The natural
   * sequential `for await` consumption serializes downstream processing — no
   * two requests are handed over concurrently.
   *
   * @param opts.signal - Abort to stop the stream.
   * @yields Each authenticated request, in discovery order.
   */
  async *requests(opts?: {
    signal?: AbortSignal;
  }): AsyncIterableIterator<ResolvedSignetRequest> {
    while (!opts?.signal?.aborted) {
      const batch = await this.poll();
      for (const resolved of batch) yield resolved;
      if (opts?.signal?.aborted) break;
      await sleepUnlessAborted(this.pollIntervalMs, opts?.signal);
    }
  }
}
