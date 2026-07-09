// Watch the CENTRAL signet contract's `Misc` events and surface ONE kind of
// signet notification (selected by the codec) as typed events in id order —
// the event-observation replacement for polling ledgers blind. Instantiated
// with `signBidirectionalEventCodec` it discovers signature requests for the
// MPC (see signet-request-feed.ts); with `signatureRespondedEventCodec` it
// discovers posted signature responses for the requesting client (see
// signet-response-feed.ts). The observer only DISCOVERS; authenticating /
// verifying what an event points at is its consumer's job. The event is a
// ping, never the source of truth — see
// knowledge-base/caller-attribution.md.

import type {
  ContractEvent,
  ContractEventQueryFilter,
  PublicDataProvider,
} from "@midnight-ntwrk/midnight-js-types";

import {
  eventNameTag,
  hexToBytes,
  type SignetMiscEventCodec,
} from "./signet-events.ts";

/** Default gap between polls of the indexer's event stream. */
export const DEFAULT_EVENT_POLL_INTERVAL_MS = 3000;

/**
 * The least of midnight-js's `PublicDataProvider` the event path needs: read a
 * contract's events, and (optionally) stream them live. Declared structurally
 * so tests can satisfy it with a plain stub; any full `PublicDataProvider`
 * (e.g. `indexerPublicDataProvider`) is assignable to it.
 */
export interface SignetEventSource {
  /**
   * Point-in-time read of a contract's events matching `filter`.
   *
   * @param filter - The event filter; `contractAddress` is required, an empty
   *   `types` array is rejected (omit for all).
   * @returns The matching events, in ascending indexer-id order.
   */
  queryContractEvents(filter: ContractEventQueryFilter): Promise<ContractEvent[]>;
  /**
   * Optional live stream, for a future push path. Typed off
   * `PublicDataProvider` so a full provider stays assignable; the observer's
   * default path polls {@link queryContractEvents}.
   */
  contractEventsObservable?: PublicDataProvider["contractEventsObservable"];
}

/** Everything a {@link SignetEventObserver} needs. */
export interface SignetEventObserverConfig<T> {
  /** Address of the central signet contract whose events to watch. */
  readonly signetContractAddress: string;
  /** Source of contract events, e.g. midnight-js's `indexerPublicDataProvider`. */
  readonly source: SignetEventSource;
  /**
   * Which signet event kind to surface: the `Misc.name` tag to filter on and
   * the payload decoder, e.g. `signBidirectionalEventCodec` or
   * `signatureRespondedEventCodec` (signet-events.ts).
   */
  readonly codec: SignetMiscEventCodec<T>;
  /**
   * Durable resume floor: only events with `id >= fromEventId` are considered
   * (the in-memory cursor of a prior run, persisted across restarts so nothing
   * is missed or replayed). Defaults to 0 — the start of the event stream.
   */
  readonly fromEventId?: number;
  /** Poll cadence for {@link SignetEventObserver.watch}; default {@link DEFAULT_EVENT_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number;
}

/**
 * Resolve after `ms`, or immediately once `signal` aborts. Used to space out
 * polls without wedging a shutdown.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

/**
 * Watches one signet contract's `Misc` events and surfaces the notifications
 * of ONE kind among them (the codec's name tag), decoded and in ascending
 * indexer-id order. A single decode failure is logged and skipped — one
 * malformed event never stalls the stream.
 */
export class SignetEventObserver<T> {
  private readonly signetContractAddress: string;
  private readonly source: SignetEventSource;
  private readonly codec: SignetMiscEventCodec<T>;
  private readonly fromEventId: number;
  private readonly pollIntervalMs: number;

  /**
   * @param config - The signet contract, event source, codec, and resume floor.
   */
  constructor(config: SignetEventObserverConfig<T>) {
    this.signetContractAddress = config.signetContractAddress;
    this.source = config.source;
    this.codec = config.codec;
    this.fromEventId = config.fromEventId ?? 0;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_EVENT_POLL_INTERVAL_MS;
  }

  /** The `Misc` filter for the watched signet contract. */
  private filter(): ContractEventQueryFilter {
    return { contractAddress: this.signetContractAddress, types: ["Misc"] };
  }

  /**
   * Every currently-visible notification of the codec's kind at or after the
   * resume floor, each paired with its indexer cursor id, ascending by id.
   * Non-`Misc` events, other name tags, and decode failures are dropped
   * (failures logged).
   */
  private async scan(): Promise<Array<{ id: number; event: T }>> {
    const events = await this.source.queryContractEvents(this.filter());
    const out: Array<{ id: number; event: T }> = [];
    for (const event of events) {
      if (event.eventType !== "Misc") continue;
      if (event.id < this.fromEventId) continue;
      if (eventNameTag(event.name) !== this.codec.tag) continue;
      let decoded: T;
      try {
        decoded = this.codec.decode(hexToBytes(event.payload));
      } catch (error) {
        console.warn(
          `SignetEventObserver: dropping undecodable ${this.codec.tag} ` +
            `event id=${event.id}: ${String(error)}`,
        );
        continue;
      }
      out.push({ id: event.id, event: decoded });
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  /**
   * One-shot: every notification of the codec's kind currently visible at or
   * after the resume floor, in id order. The polling feeds
   * ({@link SignetRequestFeed}, `SignetResponseFeed`) re-scan through this
   * each cycle (so a not-yet-indexed write is retried); it does NOT advance a
   * cursor — the feeds dedupe by content instead.
   *
   * @returns The decoded notifications, ascending by indexer id.
   */
  async currentEvents(): Promise<T[]> {
    return (await this.scan()).map((entry) => entry.event);
  }

  /**
   * Live stream: poll the event source forever, yielding each notification
   * exactly once in id order — nothing at or below the last yielded id is
   * re-emitted (the cursor advances as `id + 1`, matching the indexer's
   * resume convention). Runs until `opts.signal` aborts.
   *
   * @param opts.signal - Abort to stop the stream (between polls or on the next yield).
   * @yields Each decoded notification once, ascending by indexer id.
   */
  async *watch(opts?: { signal?: AbortSignal }): AsyncIterableIterator<T> {
    let cursor = this.fromEventId;
    while (!opts?.signal?.aborted) {
      const batch = await this.scan();
      for (const { id, event } of batch) {
        if (id < cursor) continue;
        yield event;
        cursor = id + 1;
      }
      if (opts?.signal?.aborted) break;
      await sleep(this.pollIntervalMs, opts?.signal);
    }
  }
}

export { sleep as sleepUnlessAborted };
