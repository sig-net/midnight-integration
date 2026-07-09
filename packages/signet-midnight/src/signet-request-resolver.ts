// Turn a SignBidirectionalEvent notification into an AUTHENTICATED request
// record. This is the security core of the event flow (see
// knowledge-base/caller-attribution.md and the invariants in this task's
// brief): the event says only WHERE to look; the request that gets signed is
// read from the named caller's own authenticated ledger, and the event's
// `requestId` must be a member of that contract's request index. An attacker
// cannot write into a contract it does not control, so a forged event can at
// most re-point at a legitimate request that already exists — never inject one.
//
// Key derivation stays f(callerAddress, path), keyed off the contract whose
// authenticated state was actually read — exactly today's guarantee, now
// reached via an event ping instead of per-contract polling.

import { lookupSignetRequestAt } from "./signature-requests-state-reader.ts";
import type { RawContractState } from "./signature-state-reading.ts";
import type { SignBidirectionalEvent } from "./signet-events.ts";
import type { SignetPublicStateSource } from "./signet-request-response-reader.ts";
import type {
  RequestIdHex,
  SignBidirectionalRequest,
} from "./signet-requests.ts";

/**
 * A {@link SignBidirectionalEvent} resolved to the authenticated request it
 * refers to: the request record read from `callerAddress`'s own ledger, with
 * `requestId` confirmed to be a member of that contract's index.
 */
export interface ResolvedSignetRequest {
  /**
   * The contract whose authenticated state the request was read from — the
   * epsilon-derivation predecessor. Key derivation keys off THIS, never off a
   * field taken from the event on faith.
   */
  callerAddress: string;
  /** The request id, confirmed to be a member of `callerAddress`'s index. */
  requestId: RequestIdHex;
  /** The authenticated request record to sign. */
  request: SignBidirectionalRequest;
}

/** Everything a {@link SignetRequestResolver} needs. */
export interface SignetRequestResolverConfig {
  /** Source of raw contract state, e.g. midnight-js's `indexerPublicDataProvider`. */
  readonly source: SignetPublicStateSource;
}

/**
 * Resolves {@link SignBidirectionalEvent} notifications to authenticated
 * {@link ResolvedSignetRequest}s by reading the named caller's ledger and
 * enforcing the membership check. Construct once and reuse: resolved records
 * are immutable (their ledger key is their hash), so they are cached by request
 * id and a repeated notification for the same request costs no query.
 *
 * NB the cache is keyed by request id, NOT by contract address: a caller
 * contract's state grows as it stores new requests, so caching its state would
 * make the resolver blind to later requests from the same caller. Caching the
 * immutable resolved record instead is the same pattern
 * {@link SignetRequestResponseReader.getSignatureRequest} uses.
 */
export class SignetRequestResolver {
  private readonly source: SignetPublicStateSource;

  // Resolved records never change; cache them so a redelivered notification for
  // the same request id does not re-query the caller's state.
  private readonly resolvedCache = new Map<RequestIdHex, ResolvedSignetRequest>();

  /**
   * @param config - The state source to read caller ledgers through.
   */
  constructor(config: SignetRequestResolverConfig) {
    this.source = config.source;
  }

  /**
   * Resolve a notification to its authenticated request, or `undefined` when it
   * cannot be trusted: the caller contract has no state, or `requestId` is not
   * a member of the index at `requestsIndexField` (forged, stale, wrong field,
   * or not yet indexed — poll again). Never throws on an untrusted event; a bad
   * notification is dropped, not surfaced as an error.
   *
   * @param event - The decoded event notification.
   * @returns The authenticated request, or `undefined` to drop the event.
   */
  async resolve(
    event: SignBidirectionalEvent,
  ): Promise<ResolvedSignetRequest | undefined> {
    const cached = this.resolvedCache.get(event.requestId);
    if (cached !== undefined) {
      return cached;
    }
    let state: { data: RawContractState } | null;
    try {
      state = await this.source.queryContractState(event.callerAddress);
    } catch {
      return undefined; // caller address not a contract / transient read error
    }
    if (!state?.data) {
      return undefined; // no state at the named caller — cannot authenticate
    }
    const request = lookupSignetRequestAt(
      state.data,
      event.requestsIndexField,
      event.requestId,
    );
    if (request === undefined) {
      return undefined; // membership check failed — drop the notification
    }
    const resolved: ResolvedSignetRequest = {
      callerAddress: event.callerAddress,
      requestId: event.requestId,
      request,
    };
    this.resolvedCache.set(event.requestId, resolved);
    return resolved;
  }
}
