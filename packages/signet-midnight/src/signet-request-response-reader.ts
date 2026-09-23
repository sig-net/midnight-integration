// Client-side reader for the signet request/response flow: fetch a request
// record from the requester contract's ledger, read the request's responses
// out of the contract events the signet contract emits, and verify each
// candidate against the request. The request id a response declares is
// UNAUTHENTICATED routing data: VERIFICATION establishes authenticity.
// Single-shot: each call queries once, and the caller owns any poll loop.

import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js-types";
import type { Transaction } from "ethers";

import { type Secp256k1Point, verifyRespondBidirectionalSignature } from "./ecdsa-attestation.ts";
import type { RawContractState } from "./raw-contract-state.ts";
import { lookupSignetRequestAt } from "./signature-requests-state-reader.ts";
import { recoverSignatureResponseSigner } from "./signature-response-verification.ts";
import {
  type DecodedSignetEvent,
  decodeSignetEventNamed,
  type RespondBidirectionalEvent,
  type SignatureRespondedEvent,
  SignetEventName,
  type SignetEventRecords,
  signetEventRecordsOf,
  type SignetEventSource,
} from "./signet-contract-events.ts";
import {
  signBidirectionalEventToSignedEvmTransaction,
  signBidirectionalEventToUnsignedEvmTransaction,
} from "./signet-evtype2tx-requests.ts";
import { type RequestIdHex, type SignBidirectionalEvent, TxParamType } from "./signet-requests.ts";

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
   * (`[4]` for a flat contract's field 4, longer once chunking applies).
   */
  readonly requesterRequestsPath: readonly number[];
  /** Address of the central signet contract. */
  readonly signetContractAddress: string;
  /** Source of raw contract state, e.g. midnight-js's `indexerPublicDataProvider`. */
  readonly publicDataProvider: SignetPublicStateSource;
  /**
   * Source of the signet contract's emitted events. Read a live indexer
   * with `signetEventSourceFromIndexer`.
   */
  readonly eventSource: SignetEventSource;
}

/** The verdict on one emitted response, in emission order. */
export interface SignatureResponseVerdict {
  /** 0-based position of the post among the request's signature-response events. */
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
  /** One verdict per post, emission order. */
  verdicts: SignatureResponseVerdict[];
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
 * The first (oldest) of a request's respond-bidirectional posts whose
 * signature verifies over `serializedOutput` against `mpcResponseKey`.
 *
 * @param serializedOutput - The serialised execution output, exact unpadded bytes.
 * @param mpcResponseKey - The MPC response key the requesting contract pinned.
 * @param posts - The request's posts, in emission order.
 * @returns The first verifying post, or `undefined` when none verifies.
 */
function firstVerifiedRespondBidirectionalEvent(
  serializedOutput: Uint8Array,
  mpcResponseKey: Secp256k1Point,
  posts: readonly RespondBidirectionalEvent[],
): RespondBidirectionalEvent | undefined {
  return posts.find((post) =>
    verifyRespondBidirectionalSignature(serializedOutput, post, mpcResponseKey),
  );
}

/**
 * `SignetRequestResponseReader.getVerifiedRespondBidirectionalEvent` over
 * decoded events already in hand: no walk of the signet contract's event
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
  return firstVerifiedRespondBidirectionalEvent(
    serializedOutput,
    mpcResponseKey,
    signetEventRecordsOf(events, SignetEventName.RespondBidirectionalEvent, requestId),
  );
}

/**
 * Reader over one requester contract / signet contract pair. Construct once
 * per pair and reuse: fetched request records are cached, so repeated
 * verification calls cost one event query each.
 */
export class SignetRequestResponseReader {
  private readonly config: SignetRequestResponseReaderConfig;

  // Request records never change once stored, so cache them across calls.
  private readonly requestCache = new Map<RequestIdHex, SignBidirectionalEvent>();

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
   * @throws {Error} When the requester contract has no state or holds no
   *   request under `requestId` at the configured index path.
   */
  async getSignatureRequest(requestId: RequestIdHex): Promise<SignBidirectionalEvent> {
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
    const request = lookupSignetRequestAt(state.data, this.config.requesterRequestsPath, requestId);
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
   * Fetch the signet contract's posts of event `name` that declare
   * `requestId`, in emission order. The declared id is routing data only.
   *
   * @param name - The signet event name to keep.
   * @param requestId - The request id the kept posts must declare.
   * @returns The kept posts' records, oldest first.
   */
  private async getRecordsNamed<TName extends SignetEventName>(
    name: TName,
    requestId: RequestIdHex,
  ): Promise<SignetEventRecords[TName][]> {
    const records: SignetEventRecords[TName][] = [];
    const events = this.config.eventSource.streamSignetEvents(this.config.signetContractAddress);
    for await (const event of events) {
      const decoded = decodeSignetEventNamed(event, name);
      if (decoded?.requestId === requestId) records.push(decoded.record);
    }
    return records;
  }

  /**
   * Fetch every signature response posted under `requestId`, in emission
   * order. UNVERIFIED: any post may still be garbage, sift with
   * {@link getVerifiedSignatureRespondedEvent} first.
   *
   * @param requestId - The request id the posts must declare.
   * @returns The request's posted records, oldest first, empty when none yet.
   */
  async getSignatureRespondedEvents(requestId: RequestIdHex): Promise<SignatureRespondedEvent[]> {
    return this.getRecordsNamed(SignetEventName.SignatureRespondedEvent, requestId);
  }

  /**
   * Fetch the signature responses posted under `requestId` and verify each
   * against the request: a valid post's signature recovers to
   * `expectedSigner` (compared case-insensitively) over the signing hash of
   * the request's transaction. The first valid post wins, and every
   * candidate gets a verdict.
   *
   * @param requestId - The request id to fetch a verified response for.
   * @param expectedSigner - The EVM address (0x hex, any case) the genuine
   *   response must be signed by: the requester's MPC-derived address.
   * @returns The first valid response (if any) plus per-post verdicts.
   * @throws {Error} When the requester contract has no state or the request is
   *   not on its ledger.
   */
  async getVerifiedSignatureRespondedEvent(
    requestId: RequestIdHex,
    expectedSigner: string,
  ): Promise<VerifiedSignatureResponseResult> {
    return this.verifySignatureResponses(
      requestId,
      expectedSigner,
      await this.getSignatureRespondedEvents(requestId),
    );
  }

  /**
   * {@link getVerifiedSignatureRespondedEvent} over decoded events already in
   * hand: the one ledger read for the request (cached), and no walk of the
   * signet contract's event history. For a consumer that streamed and decoded
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
    return this.verifySignatureResponses(
      requestId,
      expectedSigner,
      signetEventRecordsOf(events, SignetEventName.SignatureRespondedEvent, requestId),
    );
  }

  /**
   * Judge each of a request's posted signature responses against the request:
   * the verdict step {@link getVerifiedSignatureRespondedEvent} and
   * {@link verifySignatureRespondedEvents} share.
   *
   * @param requestId - The request id the responses were posted under.
   * @param expectedSigner - The EVM address the genuine response must be signed by.
   * @param responses - The request's posted responses, in emission order.
   * @returns The first valid response (if any) plus per-post verdicts.
   * @throws {Error} When the requester contract has no state or the request is
   *   not on its ledger.
   */
  private async verifySignatureResponses(
    requestId: RequestIdHex,
    expectedSigner: string,
    responses: readonly SignatureRespondedEvent[],
  ): Promise<VerifiedSignatureResponseResult> {
    const request = await this.getSignatureRequest(requestId);
    const verdicts = responses.map((response, position): SignatureResponseVerdict => {
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
    });
    return {
      verified: verdicts.find((v) => v.rejectedReason === undefined)?.response,
      verdicts,
    };
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
    const { verified } = await this.getVerifiedSignatureRespondedEvent(requestId, expectedSigner);
    if (verified === undefined) {
      return undefined;
    }
    return signBidirectionalEventToSignedEvmTransaction(request, verified);
  }

  /**
   * Fetch every respond-bidirectional response posted under `requestId`, in
   * emission order. UNVERIFIED: any post may still be garbage, sift with
   * {@link getVerifiedRespondBidirectionalEvent} (or in-circuit at claim
   * time) first.
   *
   * @param requestId - The request id the posts must declare.
   * @returns The request's posted records, oldest first, empty when none yet.
   */
  async getRespondBidirectionalEvents(
    requestId: RequestIdHex,
  ): Promise<RespondBidirectionalEvent[]> {
    return this.getRecordsNamed(SignetEventName.RespondBidirectionalEvent, requestId);
  }

  /**
   * Fetch the respond-bidirectional posts declared under `requestId` and
   * return the first (oldest) one whose signature verifies over
   * `serializedOutput` against `mpcResponseKey`: the off-chain twin of the
   * check the client contract runs in-circuit. The output must be the exact
   * unpadded bytes the attestation commits to, so a post that verifies here
   * is the post that proves at claim time.
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
    return firstVerifiedRespondBidirectionalEvent(
      serializedOutput,
      mpcResponseKey,
      await this.getRespondBidirectionalEvents(requestId),
    );
  }
}
