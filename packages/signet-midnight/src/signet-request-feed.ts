// The MPC's single entry point for discovering signature requests by event
// observation: watch the central signet contract's notifications, resolve each
// to an AUTHENTICATED request read from the named caller's own ledger, and
// yield only the ones that pass the membership check. Replaces polling a
// configured list of requester contracts — the feed discovers requesters
// dynamically, keyed off whose authenticated state it actually read.
//
// The requester allow-list is an OPTIONAL policy filter here (drop requests
// from contracts you choose not to serve), never a security requirement and
// never the discovery mechanism — attribution comes from the resolver's
// authenticated read (see signet-request-resolver.ts and
// knowledge-base/caller-attribution.md).

import {
  SignetEventObserver,
  sleepUnlessAborted,
  type SignetEventSource,
} from "./signet-event-observer.ts";
import { stripHexPrefix } from "./signet-events.ts";
import {
  SignetRequestResolver,
  type ResolvedSignetRequest,
} from "./signet-request-resolver.ts";
import type { SignetPublicStateSource } from "./signet-request-response-reader.ts";
import type { RequestIdHex } from "./signet-requests.ts";

/** Default gap between poll cycles of {@link SignetRequestFeed.requests}. */
export const DEFAULT_FEED_POLL_INTERVAL_MS = 3000;

/** Everything a {@link SignetRequestFeed} needs. */
export interface SignetRequestFeedConfig {
  /** Address of the central signet contract whose events to watch. */
  readonly signetContractAddress: string;
  /**
   * Source of BOTH events and raw contract state — a full
   * `indexerPublicDataProvider` satisfies both halves.
   */
  readonly source: SignetEventSource & SignetPublicStateSource;
  /**
   * Optional policy allow-list of requester contract addresses to serve
   * (matched case- and `0x`-prefix-insensitively). Omit to serve every
   * requester the resolver can authenticate. NOT a security control.
   */
  readonly allowContracts?: Iterable<string>;
  /** Durable resume floor for the underlying observer (see {@link SignetEventObserverConfig.fromEventId}). */
  readonly fromEventId?: number;
  /** Poll cadence for {@link SignetRequestFeed.requests}; default {@link DEFAULT_FEED_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number;
}

/** Canonical form for comparing contract addresses: no `0x`, lowercase. */
function normalizeAddress(address: string): string {
  return stripHexPrefix(address).toLowerCase();
}

/**
 * The event-driven request feed. Composes a {@link SignetEventObserver}
 * (discovery) with a {@link SignetRequestResolver} (authentication), yielding
 * only notifications that resolve to a real, member request. Dedupes by request
 * id across its lifetime, so a redelivered notification is not re-yielded; call
 * {@link forget} to re-arm a request whose downstream processing failed.
 */
export class SignetRequestFeed {
  private readonly observer: SignetEventObserver;
  private readonly resolver: SignetRequestResolver;
  private readonly allowContracts?: Set<string>;
  private readonly pollIntervalMs: number;

  // Request ids already yielded. NOT the security boundary (the resolver is) —
  // just an at-most-once gate so one request is not processed twice.
  private readonly yielded = new Set<RequestIdHex>();

  /**
   * @param config - The signet contract, combined event/state source, optional
   *   policy allow-list, and resume floor.
   */
  constructor(config: SignetRequestFeedConfig) {
    this.observer = new SignetEventObserver({
      signetContractAddress: config.signetContractAddress,
      source: config.source,
      fromEventId: config.fromEventId,
      pollIntervalMs: config.pollIntervalMs,
    });
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
   * One-shot: every currently-visible notification that is admitted by the
   * allow-list, not already yielded, and resolves to an authenticated member
   * request. Forged / not-yet-indexed / wrong-field notifications resolve to
   * nothing and are dropped WITHOUT being marked yielded, so a genuine
   * request whose ledger write has not indexed yet is retried next cycle.
   *
   * @returns The newly-authenticated requests this cycle, in event id order.
   */
  async poll(): Promise<ResolvedSignetRequest[]> {
    const events = await this.observer.currentEvents();
    const out: ResolvedSignetRequest[] = [];
    for (const event of events) {
      if (this.yielded.has(event.requestId)) continue;
      if (!this.allowed(event.callerAddress)) continue;
      const resolved = await this.resolver.resolve(event);
      if (resolved === undefined) continue;
      this.yielded.add(event.requestId);
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
