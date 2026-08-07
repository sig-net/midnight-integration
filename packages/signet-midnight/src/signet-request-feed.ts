// The MPC's single entry point for discovering signature requests: poll the
// central signet contract's emitted SignBidirectionalEvent notifications,
// follow each to the named caller contract, and read the AUTHENTICATED
// request it declares from that caller's own request map. A notification is
// a doorbell, never an authority: it says only WHERE to look (caller
// address + the resolved ledger-tree path of its request map) and WHICH
// request (the declared id), and every request served comes from the named
// caller's own ledger. An attacker cannot write into a contract it does not
// control, so a forged notification can at most re-point at a legitimate
// caller's stored request, never inject one.
//
// The event log has no on-ledger cursor the feed consumes, so the feed's
// in-memory `yielded` set is the diff cursor: every poll looks up the
// notified requests and serves what it has not served before.
//
// The requester allow-list is an OPTIONAL policy filter here (drop requests
// from contracts you choose not to serve), never a security requirement and
// never the discovery mechanism: attribution comes from reading the
// caller's authenticated state.

import { lookupSignetRequestAt } from "./signature-requests-state-reader.ts";
import type { RawContractState } from "./signature-state-reading.ts";
import {
  decodeSignBidirectionalEventNotificationPayload,
  decodeSignBidirectionalNotification,
  isSignetEventNamed,
  SignetEventName,
  type SignetEventSource,
} from "./signet-contract-events.ts";
import type { SignetPublicStateSource } from "./signet-request-response-reader.ts";
import {
  type RequestIdHex,
  requestIdHex,
  type SignBidirectionalEvent,
  stripHexPrefix,
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
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
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

/**
 * Canonical form for comparing contract addresses: no `0x`, lowercase.
 *
 * @param address - The contract address to canonicalise.
 * @returns The address as lowercase hex with no prefix.
 */
function normalizeAddress(address: string): string {
  return stripHexPrefix(address).toLowerCase();
}

/**
 * The event-polling request feed. Reads the signet contract's emitted
 * notifications (discovery) and looks each declared request id up in the
 * pointed-at caller's own request map (authentication by construction: the
 * records come from the caller's ledger), yielding each found request once.
 * A request stored WITHOUT a notification is never discovered: the
 * notification is the doorbell. Dedupes by request id across its lifetime,
 * so a re-notified or still-pending request is not re-yielded. Call
 * {@link forget} to re-arm a request whose downstream processing failed.
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
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_FEED_POLL_INTERVAL_MS;
  }

  /**
   * Whether the policy allow-list admits `callerAddress` (always true when unset).
   *
   * @param callerAddress - The caller contract address to check.
   * @returns Whether the feed may yield this caller's requests.
   */
  private allowed(callerAddress: string): boolean {
    return (
      this.allowContracts === undefined || this.allowContracts.has(normalizeAddress(callerAddress))
    );
  }

  /**
   * The unique `(callerAddress, requestsPath, requestId)` pointers of the
   * currently emitted notification events, allow-list applied, in ascending
   * (caller-address, request-id) order (event enumeration order is
   * per-source, so a stable sort keeps the poll deterministic). Deduped by
   * the FULL triple, not the id alone, so a forged notification declaring a
   * genuine id under a wrong pointer cannot shadow the genuine one.
   * Undecodable or unsupported-version events are skipped (and logged):
   * they carry no readable pointer, so nothing is lost.
   *
   * @returns The deduplicated pointers to look up this cycle.
   */
  private async notificationPointers(): Promise<
    { callerAddress: string; requestsPath: number[]; requestId: RequestIdHex }[]
  > {
    const events = await this.eventSource.querySignetEvents(this.signetContractAddress);
    const pointers = new Map<
      string,
      { callerAddress: string; requestsPath: number[]; requestId: RequestIdHex }
    >();
    for (const event of events) {
      if (!isSignetEventNamed(event, SignetEventName.SignBidirectionalEvent)) continue;
      let pointer;
      try {
        const post = decodeSignBidirectionalEventNotificationPayload(event.payload);
        const notification = decodeSignBidirectionalNotification(post.event);
        pointer = {
          callerAddress: notification.callerAddress,
          requestsPath: notification.requestsPath,
          requestId: requestIdHex(post.requestId),
        };
      } catch (error) {
        console.warn(
          `SignetRequestFeed: skipping undecodable notification event: ${String(error)}`,
        );
        continue;
      }
      if (!this.allowed(pointer.callerAddress)) continue;
      pointers.set(
        `${pointer.callerAddress}:${pointer.requestsPath.join(",")}:${pointer.requestId}`,
        pointer,
      );
    }
    return [...pointers.values()].sort((a, b) => {
      const byCaller =
        a.callerAddress < b.callerAddress ? -1 : a.callerAddress > b.callerAddress ? 1 : 0;
      if (byCaller !== 0) return byCaller;
      return a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0;
    });
  }

  /**
   * One-shot: every notified request that is admitted by the allow-list,
   * not already yielded, and found by id in the pointed-at caller's own
   * request map. A pointer whose caller has no readable state, whose path
   * holds no request map, or whose declared id is not (yet) a member yields
   * nothing WITHOUT marking anything, so a genuine request whose ledger
   * write has not indexed yet is retried next cycle. One caller's state is
   * queried at most once per cycle.
   *
   * @returns The newly-discovered authenticated requests this cycle.
   * @throws {Error} When the event source itself fails (e.g. the indexer is
   *   unreachable).
   */
  async poll(): Promise<ResolvedSignetRequest[]> {
    const out: ResolvedSignetRequest[] = [];
    // Per-cycle caller-state cache: null marks a caller whose state could
    // not be read this cycle (not a contract / transient read error).
    const states = new Map<string, RawContractState | null>();
    for (const pointer of await this.notificationPointers()) {
      if (this.yielded.has(pointer.requestId)) continue;
      let raw = states.get(pointer.callerAddress);
      if (raw === undefined) {
        try {
          raw = (await this.source.queryContractState(pointer.callerAddress))?.data ?? null;
        } catch {
          raw = null;
        }
        states.set(pointer.callerAddress, raw);
      }
      if (raw === null) {
        continue; // no state at the named caller: nothing to serve yet
      }
      const request = lookupSignetRequestAt(raw, pointer.requestsPath, pointer.requestId);
      if (request === undefined) {
        continue; // forged pointer, or the ledger write has not indexed yet
      }
      this.yielded.add(pointer.requestId);
      out.push({
        callerAddress: pointer.callerAddress,
        requestId: pointer.requestId,
        request,
      });
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
   * @param opts - Stream options.
   * @param opts.signal - Abort to stop the stream.
   * @yields {ResolvedSignetRequest} Each authenticated request, in discovery order.
   */
  async *requests(opts?: { signal?: AbortSignal }): AsyncIterableIterator<ResolvedSignetRequest> {
    while (!opts?.signal?.aborted) {
      const batch = await this.poll();
      for (const resolved of batch) yield resolved;
      if (opts?.signal?.aborted) break;
      await sleepUnlessAborted(this.pollIntervalMs, opts?.signal);
    }
  }
}
