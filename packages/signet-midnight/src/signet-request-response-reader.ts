// Client-side reader for the signet request/response flow: fetch a request
// record from the requester contract's ledger, read the request's responses
// out of the contract events the signet responder emits, and verify each
// candidate against the request. The request id a response declares is
// UNAUTHENTICATED routing data: VERIFICATION establishes authenticity.
// The caller owns the poll loop, and the reader makes each poll incremental:
// per request it keeps the distinct responses read so far, each one's
// verification outcome, and the event cursor its next scan resumes from.

import { ContractState } from "@midnight-ntwrk/compact-runtime";
import type {
  PublicDataProvider,
  SerializedContractState,
} from "@midnight-ntwrk/midnight-js-types";
import type { Transaction } from "ethers";

import { bytesToHex } from "./byte-codecs.ts";
import {
  formatSecp256k1PublicKey,
  type Secp256k1Point,
  verifyAttestedOutput,
  verifyRespondBidirectionalAttestation,
} from "./ecdsa-attestation.ts";
import { lookupSignetRequestAt } from "./signature-requests-state-reader.ts";
import { recoverSignatureResponseSigner } from "./signature-response-verification.ts";
import {
  type DecodedSignetEvent,
  decodeSignetEventNamed,
  type IndexedSignetMiscEvent,
  type RespondBidirectionalEvent,
  type SignatureRespondedEvent,
  SignetEventName,
  signetEventRecordsOf,
  type SignetEventSource,
} from "./signet-contract-events.ts";
import {
  signBidirectionalEventToSignedEvmTransaction,
  signBidirectionalEventToUnsignedEvmTransaction,
} from "./signet-evtype2tx-requests.ts";
import { type RequestIdHex, type SignBidirectionalEvent, TxParamType } from "./signet-requests.ts";

/**
 * The least of midnight-js's `PublicDataProvider` the reader needs: a
 * contract's serialized state by address. Declared structurally so tests can
 * satisfy it with a plain stub. Any full `PublicDataProvider`
 * (e.g. `indexerPublicDataProvider`) is assignable to it.
 */
export interface SignetPublicStateSource {
  /**
   * Retrieve the on-chain state of a contract at the latest block.
   *
   * @param contractAddress - The contract address to query.
   * @returns The read, whose `contractState` is a ledger-9 contract state, or
   *   `null` when the address holds no contract.
   */
  queryContractState(
    contractAddress: Parameters<PublicDataProvider["queryContractState"]>[0],
  ): Promise<{ readonly contractState: SerializedContractState } | null>;
}

/** Everything a {@link SignetRequestResponseReader} needs to operate. */
export interface SignetRequestResponseReaderConfig {
  /** Address of the signet-compliant requester contract (e.g. the vault). */
  readonly requesterContractAddress: string;
  /**
   * Resolved ledger-tree path of the requester contract's request index: the
   * same path the contract packs as `requestsPath` in its notifications
   * (`[4]` for a flat contract's field 4, longer once chunking applies).
   */
  readonly requesterRequestsPath: readonly number[];
  /**
   * Address of the signet responder contract, which emits the MPC's
   * responses (see `getResponderContractAddress`).
   */
  readonly responderContractAddress: string;
  /** Source of raw contract state, e.g. midnight-js's `indexerPublicDataProvider`. */
  readonly publicDataProvider: SignetPublicStateSource;
  /**
   * Source of the responder contract's emitted events, each carrying the
   * indexer's event cursor the reader resumes its scans from. Read a live
   * indexer with `signetEventSourceFromIndexer`.
   */
  readonly eventSource: SignetEventSource<IndexedSignetMiscEvent>;
  /**
   * Inclusive lowest Midnight block a request's FIRST scan for responses
   * starts at: later scans of that request resume from its own cursor. Omit
   * to start at the beginning of the history. Set it to the block just
   * before the oldest request whose responses are still pending: responses
   * are emitted after their request, so the tip taken BEFORE submitting the
   * first request is safe for a fresh client. A value above that block hides
   * the request's responses without error, and a value far below it makes
   * every first scan walk history that cannot hold a response.
   */
  readonly responderEventsFromBlock?: number;
}

/** The verdict on one emitted response, in emission order. */
export interface SignatureResponseVerdict {
  /** 0-based position of the post among the signature responses judged. */
  index: bigint;
  /** The posted signature record, verbatim. */
  response: SignatureRespondedEvent;
  /** Recovered signer address, absent when the signature did not decode. */
  signer?: string;
  /** Why the post was rejected, absent when the post is valid. */
  rejectedReason?: string;
}

/** Result of {@link SignetRequestResponseReader['getSignatureResponseVerdicts']}. */
export interface VerifiedSignatureResponseResult {
  /**
   * The first valid response (lowest index), or `undefined` when no valid
   * response has been posted yet: poll again.
   */
  verified?: SignatureRespondedEvent;
  /** One verdict per post, emission order. */
  verdicts: SignatureResponseVerdict[];
}

/** The outcome of recovering a posted signature response's signer. */
type SignerRecovery =
  | {
      /** The recovered signer address. */
      signer: string;
    }
  | {
      /** Why the post is not a decodable signature. */
      undecodable: string;
    };

/**
 * Recover the signer of a posted signature response over the request's
 * transaction: the one cryptographic step of judging a post.
 *
 * @param request - The request the response was posted for.
 * @param response - The posted response.
 * @returns The recovered signer, or why the signature does not decode.
 */
function recoverSigner(
  request: SignBidirectionalEvent,
  response: SignatureRespondedEvent,
): SignerRecovery {
  try {
    return { signer: recoverSignatureResponseSigner(request, response) };
  } catch (error) {
    return { undecodable: String(error) };
  }
}

/**
 * Whether a recovery names `expectedSigner`, compared case-insensitively.
 *
 * @param recovery - The post's recovery outcome.
 * @param expectedSigner - The EVM address the genuine response must be signed by.
 * @returns Whether the post is signed by `expectedSigner`.
 */
function isSignedBy(recovery: SignerRecovery, expectedSigner: string): boolean {
  return "signer" in recovery && recovery.signer.toLowerCase() === expectedSigner.toLowerCase();
}

/**
 * Word a post's recovery outcome as its verdict against `expectedSigner`.
 *
 * @param position - 0-based position of the post among the responses judged.
 * @param response - The posted response.
 * @param recovery - The post's recovery outcome.
 * @param expectedSigner - The EVM address the genuine response must be signed by.
 * @returns The verdict.
 */
function signatureResponseVerdict(
  position: number,
  response: SignatureRespondedEvent,
  recovery: SignerRecovery,
  expectedSigner: string,
): SignatureResponseVerdict {
  const index = BigInt(position);
  if ("undecodable" in recovery) {
    return {
      index,
      response,
      rejectedReason: `not a decodable signature (${recovery.undecodable})`,
    };
  }
  const { signer } = recovery;
  if (!isSignedBy(recovery, expectedSigner)) {
    return {
      index,
      response,
      signer,
      rejectedReason: `signed by ${signer}, expected ${expectedSigner}`,
    };
  }
  return { index, response, signer };
}

/**
 * Collect per-post verdicts into a result: the first valid post wins.
 *
 * @param verdicts - One verdict per post, emission order.
 * @returns The first valid response (if any) plus the verdicts.
 */
function verifiedSignatureResponseResult(
  verdicts: SignatureResponseVerdict[],
): VerifiedSignatureResponseResult {
  return {
    verified: verdicts.find((verdict) => verdict.rejectedReason === undefined)?.response,
    verdicts,
  };
}

/**
 * Assert a fetched request carries the evmType2 decomposition, the only one
 * the EVM-transaction methods may read `txParams` from.
 *
 * @param request - The fetched request record.
 * @throws {Error} If the record carries any other decomposition.
 */
function assertEvmType2Request(request: SignBidirectionalEvent): void {
  if (request.txParamType !== TxParamType.evmType2) {
    throw new Error(`unsupported txParamType ${String(request.txParamType)}`);
  }
}

/**
 * `SignetRequestResponseReader.getVerifiedRespondBidirectionalEvent` over
 * decoded events already in hand: no walk of the responder contract's event
 * history, and no ledger read either, since the attestation verifies against
 * the output and the response key alone.
 *
 * @param requestId - The request id the posts must declare and the
 *   attestation must commit to.
 * @param serializedOutput - The serialised execution output the attestation
 *   must commit to, exact unpadded bytes.
 * @param mpcResponseKey - The MPC response key the requesting contract
 *   pinned at deploy (see `deriveMidnightResponseKey`).
 * @param events - Decoded signet events of any kinds and request ids, in
 *   emission order. Only attestations declaring `requestId` are judged.
 * @returns The first verifying post, or `undefined` when none attests this output.
 */
export function findVerifiedRespondBidirectionalEvent(
  requestId: RequestIdHex,
  serializedOutput: Uint8Array,
  mpcResponseKey: Secp256k1Point,
  events: readonly DecodedSignetEvent[],
): RespondBidirectionalEvent | undefined {
  // Every genuine post for a request attests the same final outcome, so the
  // output is hashed once, against the first attested post alone.
  const attested = signetEventRecordsOf(
    events,
    SignetEventName.RespondBidirectionalEvent,
    requestId,
  ).find((post) => verifyRespondBidirectionalAttestation(post, mpcResponseKey));
  if (
    attested === undefined ||
    !verifyAttestedOutput(serializedOutput, attested.serializedOutputLength, attested.outputHash)
  ) {
    return undefined;
  }
  return attested;
}

/** A distinct signature response read for a request, with its signer once recovered. */
interface SignatureResponseCandidate {
  /** The posted record. */
  response: SignatureRespondedEvent;
  /** The recovery outcome, absent until the post is first judged. */
  recovery?: SignerRecovery;
}

/** A distinct respond-bidirectional post read for a request, with its attestation checks so far. */
interface RespondBidirectionalCandidate {
  /** The posted record. */
  post: RespondBidirectionalEvent;
  /** Whether the post's signature verifies, by the `0x04…` hex of each response key it was checked against. */
  attestedBy: Map<string, boolean>;
}

/** Everything read so far of one request's responses, and where its next scan resumes. */
interface RequestResponseScan {
  /**
   * The newest responder event read. The next scan starts at its block and
   * skips ids up to its id, relying on indexer event ids ascending in
   * emission order.
   */
  lastEvent?: Pick<IndexedSignetMiscEvent, "id" | "blockHeight">;
  /** Name and payload of every post kept: a repeat of one is the same candidate. */
  readonly keptPosts: Set<string>;
  /** The request's distinct signature responses, emission order. */
  readonly signatureResponses: SignatureResponseCandidate[];
  /** The request's distinct respond-bidirectional posts, emission order. */
  readonly respondBidirectionalEvents: RespondBidirectionalCandidate[];
}

/**
 * Reader over one requester contract / responder contract pair. Construct once
 * per pair and reuse across polls: per request it caches the request record,
 * the distinct responses read so far with each one's verification outcome,
 * and the event cursor, so a poll reads only events emitted since the
 * previous one and no response is verified twice.
 */
export class SignetRequestResponseReader {
  private readonly config: SignetRequestResponseReaderConfig;

  // Request records never change once stored, so cache them across calls.
  private readonly requestCache = new Map<RequestIdHex, SignBidirectionalEvent>();

  private readonly responseScans = new Map<RequestIdHex, RequestResponseScan>();

  /**
   * @param config - The contract pair, state source and event source to read
   *   through.
   */
  constructor(config: SignetRequestResponseReaderConfig) {
    this.config = config;
  }

  /**
   * Fetch the request record for `requestId` from the requester contract's
   * request index. Cached after the first fetch.
   *
   * @param requestId - The request id to look up.
   * @returns The stored request record.
   * @throws {Error} When the requester contract has no state, its state does
   *   not decode as a ledger-9 contract state, or it holds no request under
   *   `requestId` at the configured index path.
   */
  async getSignatureRequest(requestId: RequestIdHex): Promise<SignBidirectionalEvent> {
    const cached = this.requestCache.get(requestId);
    if (cached !== undefined) {
      return cached;
    }
    const read = await this.config.publicDataProvider.queryContractState(
      this.config.requesterContractAddress,
    );
    if (!read) {
      throw new Error(
        `no state data found for requester contract '${this.config.requesterContractAddress}' (is it deployed?)`,
      );
    }
    let state: ContractState;
    try {
      state = read.contractState.deserialize({ v9: ContractState });
    } catch (cause) {
      throw new Error(
        `the "${read.contractState.era}" state of requester contract '${this.config.requesterContractAddress}' does not decode as a ledger-9 contract state`,
        { cause },
      );
    }
    const request = lookupSignetRequestAt(
      state.data,
      this.config.requesterContractAddress,
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
   * The responses read so far for `requestId`, without touching the event
   * source.
   *
   * @param requestId - The request id.
   * @returns The request's scan state, empty before its first scan.
   */
  private responseScanOf(requestId: RequestIdHex): RequestResponseScan {
    let scan = this.responseScans.get(requestId);
    if (scan === undefined) {
      scan = { keptPosts: new Set(), signatureResponses: [], respondBidirectionalEvents: [] };
      this.responseScans.set(requestId, scan);
    }
    return scan;
  }

  /**
   * Read the responder contract's events emitted since the previous scan of
   * `requestId` and keep the posts of either response kind that declare it,
   * skipping posts whose payload does not decode and repeats of a post
   * already kept. The declared id is routing data only.
   *
   * @param requestId - The request id the kept posts must declare.
   * @returns The request's scan state, read up to the indexer's tip.
   */
  private async scanResponses(requestId: RequestIdHex): Promise<RequestResponseScan> {
    const scan = this.responseScanOf(requestId);
    const fromBlock = scan.lastEvent?.blockHeight ?? this.config.responderEventsFromBlock;
    const events = this.config.eventSource.streamSignetEvents(
      this.config.responderContractAddress,
      fromBlock === undefined ? undefined : { fromBlock },
    );
    for await (const event of events) {
      if (scan.lastEvent !== undefined && event.id <= scan.lastEvent.id) continue;
      scan.lastEvent = { id: event.id, blockHeight: event.blockHeight };
      const post = `${event.name}:${bytesToHex(event.payload)}`;
      if (scan.keptPosts.has(post)) continue;
      try {
        const signatureResponse = decodeSignetEventNamed(
          event,
          SignetEventName.SignatureRespondedEvent,
        );
        if (signatureResponse?.requestId === requestId) {
          scan.keptPosts.add(post);
          scan.signatureResponses.push({ response: signatureResponse.record });
        }
        const respondBidirectional = decodeSignetEventNamed(
          event,
          SignetEventName.RespondBidirectionalEvent,
        );
        if (respondBidirectional?.requestId === requestId) {
          scan.keptPosts.add(post);
          scan.respondBidirectionalEvents.push({
            post: respondBidirectional.record,
            attestedBy: new Map(),
          });
        }
      } catch {
        // A post that does not decode answers no request, so it must not
        // fail the read of every request.
      }
    }
    return scan;
  }

  /**
   * Fetch every distinct decodable signature response posted under
   * `requestId`, in emission order. UNVERIFIED: any post may still be
   * garbage, sift with {@link getVerifiedSignatureRespondedEvent} first.
   *
   * @param requestId - The request id the posts must declare.
   * @returns The request's posted records, oldest first, empty when none yet.
   */
  async getSignatureRespondedEvents(requestId: RequestIdHex): Promise<SignatureRespondedEvent[]> {
    const scan = await this.scanResponses(requestId);
    return scan.signatureResponses.map((candidate) => candidate.response);
  }

  /**
   * The first of a request's signature responses read so far that is signed
   * by `expectedSigner`, recovering the signer of each post at most once
   * across calls and stopping at the first match.
   *
   * @param request - The request the responses were posted for.
   * @param candidates - The request's responses read so far, emission order.
   * @param expectedSigner - The EVM address the genuine response must be signed by.
   * @returns The first valid response, or `undefined` when none is valid.
   */
  private firstResponseSignedBy(
    request: SignBidirectionalEvent,
    candidates: readonly SignatureResponseCandidate[],
    expectedSigner: string,
  ): SignatureRespondedEvent | undefined {
    for (const candidate of candidates) {
      candidate.recovery ??= recoverSigner(request, candidate.response);
      if (isSignedBy(candidate.recovery, expectedSigner)) return candidate.response;
    }
    return undefined;
  }

  /**
   * Fetch the first signature response posted under `requestId` that
   * verifies against the request: its signature recovers to `expectedSigner`
   * (compared case-insensitively) over the signing hash of the request's
   * transaction. The fast path of a poll loop: a valid response already read
   * is returned without touching the event source, a scan reads only the
   * events emitted since the previous one, and verification stops at the
   * first valid post. {@link getSignatureResponseVerdicts} says why the
   * other posts were rejected.
   *
   * @param requestId - The request id to fetch a verified response for.
   * @param expectedSigner - The EVM address (0x hex, any case) the genuine
   *   response must be signed by: the requester's MPC-derived address.
   * @returns The first valid response, or `undefined` when no valid response
   *   has been posted yet: poll again.
   * @throws {Error} When the requester contract has no state or the request is
   *   not on its ledger.
   */
  async getVerifiedSignatureRespondedEvent(
    requestId: RequestIdHex,
    expectedSigner: string,
  ): Promise<SignatureRespondedEvent | undefined> {
    const request = await this.getSignatureRequest(requestId);
    return (
      this.firstResponseSignedBy(
        request,
        this.responseScanOf(requestId).signatureResponses,
        expectedSigner,
      ) ??
      this.firstResponseSignedBy(
        request,
        (await this.scanResponses(requestId)).signatureResponses,
        expectedSigner,
      )
    );
  }

  /**
   * The diagnostic sibling of {@link getVerifiedSignatureRespondedEvent}:
   * fetch every distinct signature response posted under `requestId` and
   * give each a verdict against the request. The signer of a post is
   * recovered at most once across calls.
   *
   * @param requestId - The request id to judge the responses of.
   * @param expectedSigner - The EVM address (0x hex, any case) the genuine
   *   response must be signed by: the requester's MPC-derived address.
   * @returns The first valid response (if any) plus per-post verdicts.
   * @throws {Error} When the requester contract has no state or the request is
   *   not on its ledger.
   */
  async getSignatureResponseVerdicts(
    requestId: RequestIdHex,
    expectedSigner: string,
  ): Promise<VerifiedSignatureResponseResult> {
    const request = await this.getSignatureRequest(requestId);
    const { signatureResponses } = await this.scanResponses(requestId);
    return verifiedSignatureResponseResult(
      signatureResponses.map((candidate, position) => {
        candidate.recovery ??= recoverSigner(request, candidate.response);
        return signatureResponseVerdict(
          position,
          candidate.response,
          candidate.recovery,
          expectedSigner,
        );
      }),
    );
  }

  /**
   * {@link getSignatureResponseVerdicts} over decoded events already in
   * hand: the one ledger read for the request (cached), and no walk of the
   * responder contract's event history. For a consumer that streamed and decoded
   * the history once and verifies many requests against it.
   *
   * @param requestId - The request id to verify responses for.
   * @param expectedSigner - The EVM address (0x hex, any case) the genuine
   *   response must be signed by: the requester's MPC-derived address.
   * @param events - Decoded signet events of any kinds and request ids, in
   *   emission order. Only signature responses declaring `requestId` are judged.
   * @returns The first valid response (if any) plus per-post verdicts.
   * @throws {Error} When the requester contract has no state or the request is
   *   not on its ledger.
   */
  async verifySignatureRespondedEvents(
    requestId: RequestIdHex,
    expectedSigner: string,
    events: readonly DecodedSignetEvent[],
  ): Promise<VerifiedSignatureResponseResult> {
    const request = await this.getSignatureRequest(requestId);
    return verifiedSignatureResponseResult(
      signetEventRecordsOf(events, SignetEventName.SignatureRespondedEvent, requestId).map(
        (response, position) =>
          signatureResponseVerdict(
            position,
            response,
            recoverSigner(request, response),
            expectedSigner,
          ),
      ),
    );
  }

  /**
   * Rebuild the unsigned EIP-1559 transaction for `requestId`: the exact
   * transaction the MPC signs, from the request record alone (fetched via
   * {@link getSignatureRequest}, cached).
   *
   * @param requestId - The request id whose transaction to rebuild.
   * @returns The unsigned ethers transaction (`unsignedHash` is the MPC's
   *   signing digest).
   * @throws {Error} When the requester contract has no state, holds no
   *   request under `requestId`, or the request is not an evmType2 record.
   */
  async getUnsignedEvmTransaction(requestId: RequestIdHex): Promise<Transaction> {
    const request = await this.getSignatureRequest(requestId);
    assertEvmType2Request(request);
    return signBidirectionalEventToUnsignedEvmTransaction(request);
  }

  /**
   * Assemble the broadcast-ready signed EIP-1559 transaction for
   * `requestId`, attaching the first VERIFIED response signed by
   * `expectedSigner` (see {@link getVerifiedSignatureRespondedEvent}).
   * Unverified posts are never attached.
   *
   * @param requestId - The request id to produce a signed transaction for.
   * @param expectedSigner - The EVM address (0x hex, any case) the genuine
   *   response must be signed by: the requester's MPC-derived address.
   * @returns The signed ethers transaction (`serialized` is the payload for
   *   `eth_sendRawTransaction`), or `undefined` when no valid response has
   *   been posted yet: poll again.
   * @throws {Error} When the requester contract has no state, the request is
   *   not on its ledger, or the request is not an evmType2 record.
   */
  async getSignedEvmTransaction(
    requestId: RequestIdHex,
    expectedSigner: string,
  ): Promise<Transaction | undefined> {
    const request = await this.getSignatureRequest(requestId);
    assertEvmType2Request(request);
    const verified = await this.getVerifiedSignatureRespondedEvent(requestId, expectedSigner);
    if (verified === undefined) {
      return undefined;
    }
    return signBidirectionalEventToSignedEvmTransaction(request, verified);
  }

  /**
   * Fetch every distinct decodable respond-bidirectional response posted under
   * `requestId`, in emission order. UNVERIFIED: any post may still be
   * garbage, sift with {@link getVerifiedRespondBidirectionalEvent} (or
   * in-circuit at claim time) first.
   *
   * @param requestId - The request id the posts must declare.
   * @returns The request's posted records, oldest first, empty when none yet.
   */
  async getRespondBidirectionalEvents(
    requestId: RequestIdHex,
  ): Promise<RespondBidirectionalEvent[]> {
    const scan = await this.scanResponses(requestId);
    return scan.respondBidirectionalEvents.map((candidate) => candidate.post);
  }

  /**
   * The first of a request's respond-bidirectional posts read so far whose
   * signature verifies against `mpcResponseKey`, checking each post against
   * a key at most once across calls and stopping at the first match.
   *
   * @param candidates - The request's posts read so far, emission order.
   * @param mpcResponseKey - The MPC response key the requesting contract pinned.
   * @returns The first attested post, or `undefined` when none verifies.
   */
  private firstPostAttestedBy(
    candidates: readonly RespondBidirectionalCandidate[],
    mpcResponseKey: Secp256k1Point,
  ): RespondBidirectionalEvent | undefined {
    const key = formatSecp256k1PublicKey(mpcResponseKey);
    for (const candidate of candidates) {
      let attested = candidate.attestedBy.get(key);
      if (attested === undefined) {
        attested = verifyRespondBidirectionalAttestation(candidate.post, mpcResponseKey);
        candidate.attestedBy.set(key, attested);
      }
      if (attested) return candidate.post;
    }
    return undefined;
  }

  /**
   * Fetch the respond-bidirectional posts declared under `requestId` and
   * return the first (oldest) one whose signature verifies against
   * `mpcResponseKey`, provided its attested width and output hash match
   * `serializedOutput`: the off-chain twin of the check the client contract
   * runs in-circuit. The output must be the exact unpadded bytes the
   * attestation commits to, so a post that verifies here is the post that
   * proves at claim time. An attested post already read is judged without
   * touching the event source, and a scan reads only the events emitted
   * since the previous one.
   *
   * @param requestId - The request id the posts must declare and the
   *   attestation must commit to.
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
    const attested =
      this.firstPostAttestedBy(
        this.responseScanOf(requestId).respondBidirectionalEvents,
        mpcResponseKey,
      ) ??
      this.firstPostAttestedBy(
        (await this.scanResponses(requestId)).respondBidirectionalEvents,
        mpcResponseKey,
      );
    return attested !== undefined &&
      verifyAttestedOutput(serializedOutput, attested.serializedOutputLength, attested.outputHash)
      ? attested
      : undefined;
  }
}
