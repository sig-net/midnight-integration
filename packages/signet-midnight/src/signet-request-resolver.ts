// Turn a SignBidirectionalNotification into an AUTHENTICATED request record.
// This is the security core of the discovery flow (see
// knowledge-base/caller-attribution.md): the notification says only WHERE to
// look; the request that gets signed is read from the named caller's own
// authenticated ledger, and the notification's `requestId` must be a member
// of that contract's request index. An attacker cannot write into a contract
// it does not control, so a forged notification can at most re-point at a
// legitimate request that already exists — never inject one.
//
// Key derivation stays f(callerAddress, path), keyed off the contract whose
// authenticated state was actually read — the notification registry is a
// pointer board, never an authority.

import { lookupSignetRequestAt } from "./signature-requests-state-reader.ts";
import type { RawContractState } from "./signature-state-reading.ts";
import type { SignBidirectionalNotification } from "./signet-contract-state-reader.ts";
import type { SignetPublicStateSource } from "./signet-request-response-reader.ts";
import type {
  RequestIdHex,
  SignBidirectionalEvent,
} from "./signet-requests.ts";

/**
 * A {@link SignBidirectionalNotification} resolved to the authenticated
 * request it refers to: the request record read from `callerAddress`'s own
 * ledger, with `requestId` confirmed to be a member of that contract's index.
 */
export interface ResolvedSignetRequest {
  /**
   * The contract whose authenticated state the request was read from — the
   * epsilon-derivation predecessor. Key derivation keys off THIS, never off a
   * field taken from the notification on faith.
   */
  callerAddress: string;
  /** The request id, confirmed to be a member of `callerAddress`'s index. */
  requestId: RequestIdHex;
  /** The authenticated request record to sign. */
  request: SignBidirectionalEvent;
}

/** Everything a {@link SignetRequestResolver} needs. */
export interface SignetRequestResolverConfig {
  /** Source of raw contract state, e.g. midnight-js's `indexerPublicDataProvider`. */
  readonly source: SignetPublicStateSource;
}

/**
 * Resolves {@link SignBidirectionalNotification}s to authenticated
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
   * a member of the map at `requestsIndexField` (forged, stale, wrong field,
   * or not yet indexed — poll again). Never throws on an untrusted
   * notification; a bad one is dropped, not surfaced as an error.
   *
   * @param requestId - The request id the notification was registered under
   *   (the registry map key — the V1 payload does not carry one).
   * @param notification - The decoded notification.
   * @returns The authenticated request, or `undefined` to drop the notification.
   */
  async resolve(
    requestId: RequestIdHex,
    notification: SignBidirectionalNotification,
  ): Promise<ResolvedSignetRequest | undefined> {
    const cached = this.resolvedCache.get(requestId);
    if (cached !== undefined) {
      return cached;
    }
    let state: { data: RawContractState } | null;
    try {
      state = await this.source.queryContractState(notification.callerAddress);
    } catch {
      return undefined; // caller address not a contract / transient read error
    }
    if (!state?.data) {
      return undefined; // no state at the named caller — cannot authenticate
    }
    const request = lookupSignetRequestAt(
      state.data,
      notification.requestsIndexField,
      requestId,
    );
    if (request === undefined) {
      return undefined; // membership check failed — drop the notification
    }
    const resolved: ResolvedSignetRequest = {
      callerAddress: notification.callerAddress,
      requestId,
      request,
    };
    this.resolvedCache.set(requestId, resolved);
    return resolved;
  }
}
