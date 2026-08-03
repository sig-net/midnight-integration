// The MPC's single entry point for discovering signature requests: poll the
// central signet contract's emitted SignBidirectionalEvent notifications,
// follow each to the named caller contract, and enumerate the AUTHENTICATED
// requests in that caller's own request map. A notification is a doorbell,
// never an authority: it says only WHERE to look (caller address + the
// resolved ledger-tree path of its request map), and every request served
// comes from the named caller's own ledger. An attacker cannot write into a
// contract it does not control, so a forged notification can at most
// re-point at a legitimate caller's map, never inject a request.
//
// The event log has no on-ledger cursor the feed consumes, so the feed's
// in-memory `yielded` set is the diff cursor: every poll enumerates the
// pointed-at maps and serves what it has not served before.
//
// The requester allow-list is an OPTIONAL policy filter here (drop requests
// from contracts you choose not to serve), never a security requirement and
// never the discovery mechanism: attribution comes from reading the
// caller's authenticated state.

import {
  decodeSignBidirectionalEventNotificationPayload,
  decodeSignBidirectionalNotification,
  SignetEventName,
  type SignetEventSource,
} from "./signet-contract-events.ts";
import { readSignetRequestIndexAt } from "./signature-requests-state-reader.ts";
import type { SignetPublicStateSource } from "./signet-request-response-reader.ts";
import {
  stripHexPrefix,
  type RequestIdHex,
  type SignBidirectionalEvent,
} from "./signet-requests.ts";

/** Default gap between poll cycles of {@link SignetRequestFeed.requests}. */
export const DEFAULT_FEED_POLL_INTERVAL_MS = 3000;

/**
 * A request discovered through a notification event and read from the named
 * caller's own authenticated ledger.
 */
export interface ResolvedSignetRequest {
  /**
   * The contract whose authenticated state the request was read from: the
   * epsilon-derivation predecessor. Key derivation keys off THIS, never off a
   * field taken from the notification on faith.
   */
  callerAddress: string;
  /** The request id the record is stored under in `callerAddress`'s index. */
  requestId: RequestIdHex;
  /** The authenticated request record to sign. */
  request: SignBidirectionalEvent;
}

/** Everything a {@link SignetRequestFeed} needs. */
export interface SignetRequestFeedConfig {
  /** Address of the central signet contract whose notification events to poll. */
  readonly signetContractAddress: string;
  /**
   * Source of raw contract state for the requester ledgers the feed
   * enumerates. A full `indexerPublicDataProvider` is assignable.
   */
  readonly source: SignetPublicStateSource;
  /**
   * Source of the signet contract's emitted events (discovery). Adapt a full
   * provider with `signetEventSourceFromPublicDataProvider`.
   */
  readonly eventSource: SignetEventSource;
  /**
   * Optional policy allow-list of requester contract addresses to serve
   * (matched case- and `0x`-prefix-insensitively). Omit to serve every
   * requester a notification points at. NOT a security control.
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
 * The event-polling request feed. Reads the signet contract's emitted
 * notifications (discovery) and enumerates each pointed-at caller's own
 * request map (authentication by construction: the records come from the
 * caller's ledger), yielding each member request once. Dedupes by request id
 * across its lifetime, so a re-notified or still-pending request is not
 * re-yielded. Call {@link forget} to re-arm a request whose downstream
 * processing failed.
 */
export class SignetRequestFeed {
  private readonly signetContractAddress: string;
  private readonly source: SignetPublicStateSource;
  private readonly eventSource: SignetEventSource;
  private readonly allowContracts?: Set<string>;
  private readonly pollIntervalMs: number;

  // Request ids already yielded. NOT the security boundary (the caller-ledger
  // read is), just an at-most-once gate so one request is not processed twice.
  private readonly yielded = new Set<RequestIdHex>();

  /**
   * @param config - The signet contract, state and event sources, and
   *   optional policy allow-list.
   */
  constructor(config: SignetRequestFeedConfig) {
    this.signetContractAddress = config.signetContractAddress;
    this.source = config.source;
    this.eventSource = config.eventSource;
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
   * The unique `(callerAddress, requestsPath)` pointers of the currently
   * emitted notification events, allow-list applied, in ascending
   * caller-address order (event enumeration order is per-source, so a
   * stable sort keeps the poll deterministic). Undecodable or
   * unsupported-version events are skipped (and logged): they carry no
   * request, so nothing is lost.
   *
   * @returns The deduplicated pointers to enumerate this cycle.
   */
  private async notificationPointers(): Promise<
    { callerAddress: string; requestsPath: number[] }[]
  > {
    const events = await this.eventSource.querySignetEvents(
      this.signetContractAddress,
    );
    const pointers = new Map<
      string,
      { callerAddress: string; requestsPath: number[] }
    >();
    for (const event of events) {
      if (event.name !== SignetEventName.SignBidirectionalEvent) continue;
      let notification;
      try {
        notification = decodeSignBidirectionalNotification(
          decodeSignBidirectionalEventNotificationPayload(event.payload),
        );
      } catch (error) {
        console.warn(
          `SignetRequestFeed: skipping undecodable notification event: ${String(error)}`,
        );
        continue;
      }
      if (!this.allowed(notification.callerAddress)) continue;
      pointers.set(
        `${notification.callerAddress}:${notification.requestsPath.join(",")}`,
        {
          callerAddress: notification.callerAddress,
          requestsPath: notification.requestsPath,
        },
      );
    }
    return [...pointers.values()].sort((a, b) =>
      a.callerAddress < b.callerAddress
        ? -1
        : a.callerAddress > b.callerAddress
          ? 1
          : 0,
    );
  }

  /**
   * One-shot: every request in a notified caller's request map that is
   * admitted by the allow-list and not already yielded. Within one caller's
   * map, requests are processed in ascending request-id-hex order: a
   * stable, deterministic sequence. A pointer at a caller with no readable
   * state, or at a field that is not a request map, yields nothing WITHOUT
   * marking anything, so a genuine request whose ledger write has not
   * indexed yet is retried next cycle.
   *
   * @returns The newly-discovered authenticated requests this cycle.
   * @throws Error when the event source itself fails (e.g. the indexer is
   *   unreachable).
   */
  async poll(): Promise<ResolvedSignetRequest[]> {
    const out: ResolvedSignetRequest[] = [];
    for (const pointer of await this.notificationPointers()) {
      let state;
      try {
        state = await this.source.queryContractState(pointer.callerAddress);
      } catch {
        continue; // caller address not a contract / transient read error
      }
      if (!state?.data) {
        continue; // no state at the named caller: nothing to serve yet
      }
      const index = readSignetRequestIndexAt(
        state.data,
        pointer.requestsPath,
      );
      for (const [requestId, request] of [...index.entries()].sort(
        ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
      )) {
        if (this.yielded.has(requestId)) continue;
        this.yielded.add(requestId);
        out.push({
          callerAddress: pointer.callerAddress,
          requestId,
          request,
        });
      }
    }
    return out;
  }

  /**
   * Re-arm `requestId` for redelivery on the next {@link poll} / {@link requests}
   * cycle: call when downstream processing of a yielded request failed, so it
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
   * sequential `for await` consumption serializes downstream processing: no
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
