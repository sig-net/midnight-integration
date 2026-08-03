// One-stop client-side reader for the signet request/response flow: fetch a
// request record from the requester contract's ledger, enumerate the
// responses the signet contract emits as contract events, and verify
// each candidate against the request.
// A response is a Misc contract event that carries a signature and nothing
// else, so no event names the request it answers. VERIFICATION is the
// correlation: a signature response
// is the answer to a request exactly when it recovers to that request's
// derived signer over the request's transaction, and a respond-bidirectional
// post is the answer exactly when it verifies over (requestId, output)
// against the request's MPC response key. This class packages that flow so
// every consumer (CLI poller, integration tests, a future UI) shares one
// implementation. Single-shot by design: each call queries once, and the
// caller owns any poll loop.

import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js-types";
import type { Transaction } from "ethers";

import { lookupSignetRequestAt } from "./signature-requests-state-reader.ts";
import {
  decodeRespondBidirectionalEventPayload,
  decodeSignatureRespondedEventPayload,
  SignetEventName,
  type SignetEventSource,
  type SignatureRespondedEvent,
  type RespondBidirectionalEvent,
} from "./signet-contract-events.ts";
import { recoverSignatureResponseSigner } from "./signature-response-verification.ts";
import {
  verifyRespondBidirectionalSignature,
  type Secp256k1Point,
} from "./ecdsa-attestation.ts";
import type { RawContractState } from "./signature-state-reading.ts";
import {
  signBidirectionalEventToSignedEvmTransaction,
  signBidirectionalEventToUnsignedEvmTransaction,
} from "./signet-evtype2tx-requests.ts";
import {
  requestIdBytes,
  type SignBidirectionalEvent,
  type RequestIdHex,
} from "./signet-requests.ts";

/**
 * The least of midnight-js's `PublicDataProvider` the reader needs: raw
 * contract state by address. Declared structurally so tests can satisfy it
 * with a plain stub. Any full `PublicDataProvider`
 * (e.g. `indexerPublicDataProvider`) is assignable to it.
 */
export interface SignetPublicStateSource {
  /**
   * Retrieve the on-chain state of a contract at the latest block.
   *
   * @param contractAddress - The contract address to query.
   * @returns The state (its `data` is the raw ledger tree), or `null` when
   *   the address holds no contract.
   */
  queryContractState(
    contractAddress: Parameters<PublicDataProvider["queryContractState"]>[0],
  ): Promise<{ data: RawContractState } | null>;
}

/** Everything a {@link SignetRequestResponseReader} needs to operate. */
export interface SignetRequestResponseReaderConfig {
  /** Address of the signet-compliant requester contract (e.g. the vault). */
  readonly requesterContractAddress: string;
  /**
   * Resolved ledger-tree path of the requester contract's request index: the
   * same path the contract packs as `requestsPath` in its notifications
   * (`[4]` for a flat contract's field 4, longer once chunking applies). A
   * contract is free to declare the index at any field, so the reader cannot
   * assume one.
   */
  readonly requesterRequestsPath: readonly number[];
  /** Address of the central signet contract. */
  readonly signetContractAddress: string;
  /** Source of raw contract state, e.g. midnight-js's `indexerPublicDataProvider`. */
  readonly publicDataProvider: SignetPublicStateSource;
  /**
   * Source of the signet contract's emitted events. Adapt a full provider
   * with `signetEventSourceFromPublicDataProvider`.
   */
  readonly eventSource: SignetEventSource;
}

/** The verdict on one emitted response, in emission order. */
export interface SignatureResponseVerdict {
  /** 0-based position of the post among the signature-response events. */
  index: bigint;
  /** The posted signature record, verbatim. */
  response: SignatureRespondedEvent;
  /** Recovered signer address, absent when the signature did not decode. */
  signer?: string;
  /** Why the post was rejected, absent when the post is valid. */
  rejectedReason?: string;
}

/** Result of {@link SignetRequestResponseReader['getVerifiedSignatureRespondedEvent']}. */
export interface VerifiedSignatureResponseResult {
  /**
   * The first valid response (lowest index), or `undefined` when no valid
   * response has been posted yet: poll again.
   */
  verified?: SignatureRespondedEvent;
  /**
   * One verdict per post, emission order. Pure data: the reader never logs,
   * so callers decide how to surface rejected posts.
   */
  verdicts: SignatureResponseVerdict[];
}

/**
 * Reader over one requester contract / signet contract pair.
 * Construct once per pair and reuse: fetched request records are cached (they
 * are immutable, the ledger key is their hash), so repeated verification
 * calls cost one event query each.
 */
export class SignetRequestResponseReader {
  private readonly config: SignetRequestResponseReaderConfig;

  // Request records never change once stored, so cache them across calls.
  private readonly requestCache = new Map<
    RequestIdHex,
    SignBidirectionalEvent
  >();

  /**
   * @param config - The contract pair, state source and event source to read
   *   through.
   */
  constructor(config: SignetRequestResponseReaderConfig) {
    this.config = config;
  }

  /**
   * Fetch the request record for `requestId` from the requester contract's
   * request index (at the configured `requesterRequestsPath`). Cached
   * after the first fetch.
   *
   * @param requestId - The request id to look up.
   * @returns The stored request record.
   * @throws Error when the requester contract has no state or holds no
   *   request under `requestId` at the configured index path.
   */
  async getSignatureRequest(
    requestId: RequestIdHex,
  ): Promise<SignBidirectionalEvent> {
    const cached = this.requestCache.get(requestId);
    if (cached !== undefined) {
      return cached;
    }
    const state = await this.config.publicDataProvider.queryContractState(
      this.config.requesterContractAddress,
    );
    if (!state?.data) {
      throw new Error(
        `no state data found for requester contract '${this.config.requesterContractAddress}' (is it deployed?)`,
      );
    }
    const request = lookupSignetRequestAt(
      state.data,
      this.config.requesterRequestsPath,
      requestId,
    );
    if (request === undefined) {
      throw new Error(
        `request ${requestId} is not on the requester contract's ledger ` +
          `(request index at path ${JSON.stringify(this.config.requesterRequestsPath)}): was it submitted?`,
      );
    }
    this.requestCache.set(requestId, request);
    return request;
  }

  /**
   * Fetch every event of `name` the signet contract has emitted and decode
   * each with `decode`, in emission order.
   *
   * @param name - The signet event name to keep.
   * @param decode - The payload decoder for that event kind.
   * @returns The decoded records, oldest first.
   */
  private async getSignetEventsNamed<T>(
    name: SignetEventName,
    decode: (payload: Uint8Array) => T,
  ): Promise<T[]> {
    const events = await this.config.eventSource.querySignetEvents(
      this.config.signetContractAddress,
    );
    return events
      .filter((event) => event.name === name)
      .map((event) => decode(event.payload));
  }

  /**
   * Fetch every signature response the signet contract has emitted, in
   * emission order. UNVERIFIED, and NOT scoped to any request: the events
   * carry a signature and nothing else, so any of them may be garbage or
   * answer someone else's request (see
   * {@link getVerifiedSignatureRespondedEvent}, where verification does the
   * matching).
   *
   * @returns The emitted response records, oldest first, empty when none yet.
   */
  async getSignatureRespondedEvents(): Promise<SignatureRespondedEvent[]> {
    return this.getSignetEventsNamed(
      SignetEventName.SignatureRespondedEvent,
      decodeSignatureRespondedEventPayload,
    );
  }

  /**
   * Fetch the emitted signature responses and verify each against
   * `requestId`'s request: a post's signature must recover to
   * `expectedSigner` (compared case-insensitively) over the signing hash of
   * the transaction the request record describes. The first valid post wins,
   * and every post gets a verdict so callers can report the noise. This
   * verification is also the request↔response matching: the events name no
   * request.
   *
   * @param requestId - The request id to fetch a verified response for.
   * @param expectedSigner - The EVM address (0x hex, any case) the genuine
   *   response must be signed by: the requester's MPC-derived address.
   * @returns The first valid response (if any) plus per-post verdicts.
   * @throws Error when the requester contract has no state or the request is
   *   not on its ledger.
   */
  async getVerifiedSignatureRespondedEvent(
    requestId: RequestIdHex,
    expectedSigner: string,
  ): Promise<VerifiedSignatureResponseResult> {
    const request = await this.getSignatureRequest(requestId);
    const responses = await this.getSignatureRespondedEvents();
    const verdicts = responses.map(
      (response, position): SignatureResponseVerdict => {
        const index = BigInt(position);
        let signer: string;
        try {
          signer = recoverSignatureResponseSigner(request, response);
        } catch (error) {
          return {
            index,
            response,
            rejectedReason: `not a decodable signature (${String(error)})`,
          };
        }
        if (signer.toLowerCase() !== expectedSigner.toLowerCase()) {
          return {
            index,
            response,
            signer,
            rejectedReason: `signed by ${signer}, expected ${expectedSigner}`,
          };
        }
        return { index, response, signer };
      },
    );
    return {
      verified: verdicts.find((v) => v.rejectedReason === undefined)?.response,
      verdicts,
    };
  }

  /**
   * Rebuild the unsigned EIP-1559 transaction for `requestId`: the exact
   * transaction the MPC signs, assembled from the request record's decomposed
   * fields. No event query: this needs only the request record
   * (fetched via {@link getSignatureRequest}, cached).
   *
   * @param requestId - The request id whose transaction to rebuild.
   * @returns The unsigned ethers transaction (`unsignedHash` is the MPC's
   *   signing digest).
   * @throws Error when the requester contract has no state or holds no
   *   request under `requestId`.
   */
  async getUnsignedEvmTransaction(
    requestId: RequestIdHex,
  ): Promise<Transaction> {
    return signBidirectionalEventToUnsignedEvmTransaction(
      await this.getSignatureRequest(requestId),
    );
  }

  /**
   * Assemble the broadcast-ready signed EIP-1559 transaction for `requestId`:
   * rebuild the request's transaction and attach the first VERIFIED response
   * signed by `expectedSigner` (see {@link getVerifiedSignatureRespondedEvent}:
   * the event log is unauthenticated, so an `expectedSigner` is required
   * and unverified posts are never attached).
   *
   * @param requestId - The request id to produce a signed transaction for.
   * @param expectedSigner - The EVM address (0x hex, any case) the genuine
   *   response must be signed by: the requester's MPC-derived address.
   * @returns The signed ethers transaction (`serialized` is the payload for
   *   `eth_sendRawTransaction`), or `undefined` when no valid response has
   *   been posted yet: poll again.
   * @throws Error when the requester contract has no state or the request is
   *   not on its ledger.
   */
  async getSignedEvmTransaction(
    requestId: RequestIdHex,
    expectedSigner: string,
  ): Promise<Transaction | undefined> {
    const { verified } = await this.getVerifiedSignatureRespondedEvent(
      requestId,
      expectedSigner,
    );
    if (verified === undefined) {
      return undefined;
    }
    // getSignatureRequest is cached: getVerifiedSignatureRespondedEvent already
    // fetched it, so this is a free lookup.
    const request = await this.getSignatureRequest(requestId);
    return signBidirectionalEventToSignedEvmTransaction(request, verified);
  }

  /**
   * Fetch every respond-bidirectional response the signet contract has
   * emitted, in emission order. UNVERIFIED, and NOT scoped to any request:
   * each post carries a signature and nothing else, so verifying it against
   * the MPC response key you expect is the only way to pick the genuine one
   * AND the only way to match a post to a request: in-circuit at claim time,
   * or off chain with {@link verifyRespondBidirectionalSignature} over the
   * output you fetched. An empty array simply means none posted yet: poll
   * again.
   *
   * @returns The emitted records, oldest first, empty when none yet.
   */
  async getRespondBidirectionalEvents(): Promise<RespondBidirectionalEvent[]> {
    return this.getSignetEventsNamed(
      SignetEventName.RespondBidirectionalEvent,
      decodeRespondBidirectionalEventPayload,
    );
  }

  /**
   * Fetch the emitted respond-bidirectional posts and return the first
   * (oldest) one whose signature verifies over `serializedOutput` against
   * `mpcResponseKey`: the off-chain twin of the check the client contract
   * runs in-circuit, and the only way to pick a genuine post out of an
   * unauthenticated event log whose posts carry nothing but a signature.
   *
   * The output must be the exact unpadded bytes the attestation commits to
   * (the packed respond payload, recomputed from the execution output the
   * client fetched), so a post that verifies here is the post that proves at
   * claim time.
   *
   * @param requestId - The request id the attestation must commit to.
   * @param serializedOutput - The serialised execution output the attestation
   *   must commit to, exact unpadded bytes.
   * @param mpcResponseKey - The MPC response key the requesting contract
   *   pinned at deploy (see `deriveMidnightResponseKey`).
   * @returns The first verifying post, or `undefined` when none has been
   *   posted yet (poll again) or none attests this output.
   */
  async getVerifiedRespondBidirectionalEvent(
    requestId: RequestIdHex,
    serializedOutput: Uint8Array,
    mpcResponseKey: Secp256k1Point,
  ): Promise<RespondBidirectionalEvent | undefined> {
    const events = await this.getRespondBidirectionalEvents();
    return events.find((event) =>
      verifyRespondBidirectionalSignature(
        requestIdBytes(requestId),
        serializedOutput,
        event,
        mpcResponseKey,
      ),
    );
  }
}
