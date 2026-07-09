// The requesting client's entry point for discovering MPC signature responses
// by event observation: watch the central signet contract's
// SignatureRespondedEvent notifications, and when one announces a post for a
// request the client cares about, read the response log back and verify every
// post against the request — the response-direction mirror of
// signet-request-feed.ts. The event is only the TRIGGER for a state read; the
// verdicts come from the ledger via the same SignetRequestResponseReader all
// other consumers use, so an event/state indexing skew in either direction is
// tolerated (a post visible in state before its event is still yielded; an
// event whose write has not indexed yet is retried next cycle).
//
// Trust model (see "Signet Contract Ledger Layout" in Signet.compact): the
// response log is UNAUTHENTICATED — neither the event nor the stored record
// confers authenticity. Only the off-chain signature verification does, which
// is why the feed yields per-post VERDICTS rather than raw responses.

import {
  SignetEventObserver,
  sleepUnlessAborted,
  type SignetEventSource,
} from "./signet-event-observer.ts";
import {
  signatureRespondedEventCodec,
  type SignatureRespondedEvent,
} from "./signet-events.ts";
import {
  SignetRequestResponseReader,
  type SignatureResponseVerdict,
  type SignetPublicStateSource,
} from "./signet-request-response-reader.ts";
import type {
  RequestIdHex,
  SignBidirectionalRequest,
} from "./signet-requests.ts";

/** Default gap between poll cycles of {@link SignetResponseFeed.verdicts}. */
export const DEFAULT_RESPONSE_FEED_POLL_INTERVAL_MS = 3000;

/** Everything a {@link SignetResponseFeed} needs. */
export interface SignetResponseFeedConfig {
  /** Address of the central signet contract whose events and response log to watch. */
  readonly signetContractAddress: string;
  /** Address of the signet-compliant requester contract holding the request records (e.g. the vault). */
  readonly requesterContractAddress: string;
  /**
   * Source of BOTH events and raw contract state — a full
   * `indexerPublicDataProvider` satisfies both halves.
   */
  readonly source: SignetEventSource & SignetPublicStateSource;
  /** Durable resume floor for the underlying observer (see {@link SignetEventObserverConfig.fromEventId}). */
  readonly fromEventId?: number;
  /** Poll cadence for {@link SignetResponseFeed.verdicts}; default {@link DEFAULT_RESPONSE_FEED_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number;
}

/**
 * The event-driven signature response feed. Composes a
 * {@link SignetEventObserver} of {@link SignatureRespondedEvent} notifications
 * (discovery) with a {@link SignetRequestResponseReader} (verification),
 * yielding one {@link SignatureResponseVerdict} per posted response, in count
 * order, each exactly once per feed lifetime. Consumers act on the first
 * valid verdict and surface the rejected ones as they see fit — the feed,
 * like the reader, never logs.
 */
export class SignetResponseFeed {
  private readonly observer: SignetEventObserver<SignatureRespondedEvent>;
  private readonly reader: SignetRequestResponseReader;
  private readonly pollIntervalMs: number;

  // Post counts already yielded, per request. NOT a trust boundary (the
  // verdicts are) — just an exactly-once gate so a post is not re-judged.
  private readonly yielded = new Map<RequestIdHex, Set<bigint>>();

  /**
   * @param config - The contract pair, combined event/state source, and
   *   resume floor.
   */
  constructor(config: SignetResponseFeedConfig) {
    this.observer = new SignetEventObserver({
      signetContractAddress: config.signetContractAddress,
      source: config.source,
      codec: signatureRespondedEventCodec,
      fromEventId: config.fromEventId,
      pollIntervalMs: config.pollIntervalMs,
    });
    this.reader = new SignetRequestResponseReader({
      requesterContractAddress: config.requesterContractAddress,
      signetContractAddress: config.signetContractAddress,
      publicDataProvider: config.source,
    });
    this.pollIntervalMs =
      config.pollIntervalMs ?? DEFAULT_RESPONSE_FEED_POLL_INTERVAL_MS;
  }

  /** The yielded-count set for `requestId`, created on first use. */
  private yieldedCounts(requestId: RequestIdHex): Set<bigint> {
    let counts = this.yielded.get(requestId);
    if (counts === undefined) {
      counts = new Set();
      this.yielded.set(requestId, counts);
    }
    return counts;
  }

  /**
   * One-shot: the verdicts on every response post for `requestId` not yielded
   * before, in count order. The response log is only read when a currently-
   * visible event announces a post this feed has not yielded yet — no new
   * event, no state query. Ledger posts the read then surfaces beyond the
   * announced ones are yielded too (events are the trigger, the ledger is the
   * source of truth), and a post whose event is visible but whose write has
   * not indexed yet is simply retried next cycle.
   *
   * @param requestId - The request whose response posts to judge.
   * @param expectedSigner - The EVM address (0x hex, any case) the genuine
   *   response must be signed by — the requester's MPC-derived address.
   * @returns The newly-judged verdicts this cycle (possibly empty).
   * @throws Error when either contract has no state, the request is not on
   *   the requester's ledger, or the responses ledger is inconsistent.
   */
  async poll(
    requestId: RequestIdHex,
    expectedSigner: string,
  ): Promise<SignatureResponseVerdict[]> {
    const events = await this.observer.currentEvents();
    const counts = this.yieldedCounts(requestId);
    const announcesNew = events.some(
      (event) => event.requestId === requestId && !counts.has(event.count),
    );
    if (!announcesNew) {
      return [];
    }
    const { verdicts } = await this.reader.getVerifiedSignatureResponse(
      requestId,
      expectedSigner,
    );
    const fresh = verdicts.filter((verdict) => !counts.has(verdict.count));
    for (const verdict of fresh) {
      counts.add(verdict.count);
    }
    return fresh;
  }

  /**
   * Live stream: poll + sleep, yielding the verdict on each posted response
   * exactly once, in count order, until `opts.signal` aborts. The natural
   * consumption is to warn on each rejected verdict and act on the first
   * valid one (see the cli's poll-signature-response command).
   *
   * @param requestId - The request whose response posts to judge.
   * @param expectedSigner - The EVM address (0x hex, any case) the genuine
   *   response must be signed by — the requester's MPC-derived address.
   * @param opts.signal - Abort to stop the stream.
   * @yields Each post's verdict, in discovery order.
   * @throws Error when either contract has no state, the request is not on
   *   the requester's ledger, or the responses ledger is inconsistent.
   */
  async *verdicts(
    requestId: RequestIdHex,
    expectedSigner: string,
    opts?: { signal?: AbortSignal },
  ): AsyncIterableIterator<SignatureResponseVerdict> {
    while (!opts?.signal?.aborted) {
      const batch = await this.poll(requestId, expectedSigner);
      for (const verdict of batch) yield verdict;
      if (opts?.signal?.aborted) break;
      await sleepUnlessAborted(this.pollIntervalMs, opts?.signal);
    }
  }

  /**
   * The request record a verdict's response answers, read through the feed's
   * own reader (cached after the first fetch — free after any {@link poll}
   * that reached verification). What a consumer needs to assemble the signed
   * transaction from a valid verdict via
   * `signBidirectionalRequestToSignedEVMTransaction`.
   *
   * @param requestId - The request id to look up.
   * @returns The stored request record.
   * @throws Error when the requester contract has no state or holds no
   *   request under `requestId`.
   */
  async getSignatureRequest(
    requestId: RequestIdHex,
  ): Promise<SignBidirectionalRequest> {
    return this.reader.getSignatureRequest(requestId);
  }
}
