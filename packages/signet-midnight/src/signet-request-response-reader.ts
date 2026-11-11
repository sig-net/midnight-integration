// Client-side reader for the signet request/response flow: fetch a request
// record from the requester contract's ledger, read the request's responses
// out of the contract events the signet responder emits, and verify each
// candidate against the request. The request id a response declares is
// UNAUTHENTICATED routing data: VERIFICATION establishes authenticity.
// Single-shot: each call queries once, and the caller owns any poll loop.

import { ContractState } from "@midnight-ntwrk/compact-runtime";
import type {
  PublicDataProvider,
  SerializedContractState,
} from "@midnight-ntwrk/midnight-js-types";
import type { Transaction } from "ethers";

import {
  type Secp256k1Point,
  verifyAttestedOutput,
  verifyRespondBidirectionalAttestation,
} from "./ecdsa-attestation.ts";
import { lookupSignetRequestAt } from "./signature-requests-state-reader.ts";
import {
  recoverSignatureResponseSigner,
  recoverTronSignatureResponseSigner,
} from "./signature-response-verification.ts";
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
import {
  type AnySignBidirectionalEvent,
  isEvmType2SignBidirectionalEvent,
  isTronSignBidirectionalEvent,
  type RequestIdHex,
  type SignBidirectionalEvent,
} from "./signet-requests.ts";
import type { TronTxParams } from "./signet-tron-requests.ts";
import {
  buildSignedTronTransaction,
  buildTronRawTransaction,
  tronAddressFromBase58,
} from "./tron-transactions.ts";

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
   * Source of the responder contract's emitted events. Read a live indexer
   * with `signetEventSourceFromIndexer`.
   */
  readonly eventSource: SignetEventSource;
  /**
   * Inclusive lowest Midnight block the reader scans for responses. Omit to
   * scan the whole history. Responses are emitted after their request, so
   * the tip taken BEFORE submitting the first request is safe for a fresh
   * client. It must not exceed the block of the oldest request whose
   * responses are still wanted: a value too high hides them without error.
   */
  readonly responderEventsFromBlock?: number;
}

/** The verdict on one emitted response, in emission order. */
export interface SignatureResponseVerdict {
  /** 0-based position of the post among the request's signature-response events. */
  index: bigint;
  /** The posted signature record, verbatim. */
  response: SignatureRespondedEvent;
  /**
   * Recovered signer address (EVM checksummed hex for an evmType2 request,
   * base58 for a Tron request), absent when the signature did not decode.
   */
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
 * Recover the signer of one posted response to `request` in the form
 * `expectedSigner` names it, and compare the two.
 *
 * @param request - The request the response answers.
 * @param response - The posted response.
 * @param expectedSigner - EVM hex for an evmType2 request, base58 for a Tron
 *   request (the owner its transaction is assembled from).
 * @returns The recovered signer and whether it is `expectedSigner`.
 * @throws {Error} If the signature does not decode or the request does not
 *   assemble into a transaction.
 */
function recoverAndMatchSigner(
  request: AnySignBidirectionalEvent,
  response: SignatureRespondedEvent,
  expectedSigner: string,
): { signer: string; matches: boolean } {
  if (isTronSignBidirectionalEvent(request)) {
    const signer = recoverTronSignatureResponseSigner(request, response, expectedSigner);
    return { signer, matches: signer === expectedSigner };
  }
  const signer = recoverSignatureResponseSigner(request, response);
  return { signer, matches: signer.toLowerCase() === expectedSigner.toLowerCase() };
}

/**
 * The first (oldest) of a request's respond-bidirectional posts whose
 * signature verifies against `mpcResponseKey`, provided it attests
 * `serializedOutput`. Every genuine post for a request attests the same final
 * outcome, so the output is hashed once, against that post alone.
 *
 * @param serializedOutput - The serialised execution output, exact unpadded bytes.
 * @param mpcResponseKey - The MPC response key the requesting contract pinned.
 * @param posts - The request's posts, in emission order.
 * @returns The first verifying post, or `undefined` when none verifies or it
 *   attests another output.
 */
function firstVerifiedRespondBidirectionalEvent(
  serializedOutput: Uint8Array,
  mpcResponseKey: Secp256k1Point,
  posts: readonly RespondBidirectionalEvent[],
): RespondBidirectionalEvent | undefined {
  const attested = posts.find((post) =>
    verifyRespondBidirectionalAttestation(post, mpcResponseKey),
  );
  if (
    attested === undefined ||
    !verifyAttestedOutput(serializedOutput, attested.serializedOutputLength, attested.outputHash)
  ) {
    return undefined;
  }
  return attested;
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
  return firstVerifiedRespondBidirectionalEvent(
    serializedOutput,
    mpcResponseKey,
    signetEventRecordsOf(events, SignetEventName.RespondBidirectionalEvent, requestId),
  );
}

/**
 * Reader over one requester contract / responder contract pair. Construct once
 * per pair and reuse: fetched request records are cached, so repeated
 * verification calls cost one event query each.
 */
export class SignetRequestResponseReader {
  private readonly config: SignetRequestResponseReaderConfig;

  // Request records never change once stored, so cache them across calls.
  private readonly requestCache = new Map<RequestIdHex, AnySignBidirectionalEvent>();

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
  async getSignatureRequest(requestId: RequestIdHex): Promise<AnySignBidirectionalEvent> {
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
   * {@link getSignatureRequest} for a request that must carry the evmType2
   * decomposition.
   *
   * @param requestId - The request id to look up.
   * @returns The stored evmType2 request record.
   * @throws {Error} When the request cannot be fetched (see
   *   {@link getSignatureRequest}) or carries another decomposition.
   */
  async getEvmType2SignatureRequest(requestId: RequestIdHex): Promise<SignBidirectionalEvent> {
    const request = await this.getSignatureRequest(requestId);
    if (!isEvmType2SignBidirectionalEvent(request)) {
      throw new Error(
        `request ${requestId} is not evmType2 (txParamType ${String(request.txParamType)})`,
      );
    }
    return request;
  }

  /**
   * {@link getSignatureRequest} for a request that must carry the Tron
   * decomposition.
   *
   * @param requestId - The request id to look up.
   * @returns The stored Tron request record.
   * @throws {Error} When the request cannot be fetched (see
   *   {@link getSignatureRequest}) or carries another decomposition.
   */
  async getTronSignatureRequest(
    requestId: RequestIdHex,
  ): Promise<SignBidirectionalEvent<TronTxParams>> {
    const request = await this.getSignatureRequest(requestId);
    if (!isTronSignBidirectionalEvent(request)) {
      throw new Error(
        `request ${requestId} is not tron (txParamType ${String(request.txParamType)})`,
      );
    }
    return request;
  }

  /**
   * Fetch the responder contract's posts of event `name` that declare
   * `requestId`, in emission order, skipping posts whose payload does not
   * decode. The declared id is routing data only.
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
    const events = this.config.eventSource.streamSignetEvents(
      this.config.responderContractAddress,
      this.config.responderEventsFromBlock === undefined
        ? undefined
        : { fromBlock: this.config.responderEventsFromBlock },
    );
    for await (const event of events) {
      try {
        const decoded = decodeSignetEventNamed(event, name);
        if (decoded?.requestId === requestId) records.push(decoded.record);
      } catch {
        // A post that does not decode answers no request, so it must not
        // fail the read of every request.
      }
    }
    return records;
  }

  /**
   * Fetch every decodable signature response posted under `requestId`, in
   * emission order. UNVERIFIED: any post may still be garbage, sift with
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
   * `expectedSigner` over the signing hash of the request's transaction (for
   * a Tron request, the id of the transaction owned by `expectedSigner`). The first valid post wins, and every
   * candidate gets a verdict.
   *
   * @param requestId - The request id to fetch a verified response for.
   * @param expectedSigner - The requester's MPC-derived address the genuine
   *   response must be signed by: EVM 0x hex (any case) for an evmType2
   *   request, base58 (see `deriveTronAddress`) for a Tron request.
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
   * @param expectedSigner - The derived address the genuine response must be
   *   signed by, in the form {@link recoverAndMatchSigner} takes.
   * @param responses - The request's posted responses, in emission order.
   * @returns The first valid response (if any) plus per-post verdicts.
   * @throws {Error} When the requester contract has no state, the request is
   *   not on its ledger, or a Tron request's `expectedSigner` is not a base58
   *   Tron address.
   */
  private async verifySignatureResponses(
    requestId: RequestIdHex,
    expectedSigner: string,
    responses: readonly SignatureRespondedEvent[],
  ): Promise<VerifiedSignatureResponseResult> {
    const request = await this.getSignatureRequest(requestId);
    if (isTronSignBidirectionalEvent(request)) {
      tronAddressFromBase58(expectedSigner);
    }
    const verdicts = responses.map((response, position): SignatureResponseVerdict => {
      const index = BigInt(position);
      let signer: string;
      let matches: boolean;
      try {
        ({ signer, matches } = recoverAndMatchSigner(request, response, expectedSigner));
      } catch (error) {
        return {
          index,
          response,
          rejectedReason: `not a decodable signature (${String(error)})`,
        };
      }
      if (!matches) {
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
    const request = await this.getEvmType2SignatureRequest(requestId);
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
    const request = await this.getEvmType2SignatureRequest(requestId);
    const { verified } = await this.getVerifiedSignatureRespondedEvent(requestId, expectedSigner);
    if (verified === undefined) {
      return undefined;
    }
    return signBidirectionalEventToSignedEvmTransaction(request, verified);
  }

  /**
   * Assemble the broadcast-ready signed Tron transaction for `requestId`:
   * the raw transaction owned by `expectedOwner` with the first VERIFIED
   * response signed by `expectedOwner` attached (see
   * {@link getVerifiedSignatureRespondedEvent}). Unverified posts are never
   * attached.
   *
   * @param requestId - The request id to produce a signed transaction for.
   * @param expectedOwner - The requester's MPC-derived Tron address in base58
   *   (see `deriveTronAddress`): the transaction's owner and its signer.
   * @returns The signed protobuf `Transaction` bytes, or `undefined` when no
   *   valid response has been posted yet: poll again.
   * @throws {Error} When the requester contract has no state, the request is
   *   not on its ledger, the request is not a Tron record, or
   *   `expectedOwner` is not a base58 Tron address.
   */
  async getSignedTronTransaction(
    requestId: RequestIdHex,
    expectedOwner: string,
  ): Promise<Uint8Array | undefined> {
    const request = await this.getTronSignatureRequest(requestId);
    const { verified } = await this.getVerifiedSignatureRespondedEvent(requestId, expectedOwner);
    if (verified === undefined) {
      return undefined;
    }
    return buildSignedTronTransaction(
      buildTronRawTransaction(request.txParams, tronAddressFromBase58(expectedOwner)),
      verified.signature,
    );
  }

  /**
   * Fetch every decodable respond-bidirectional response posted under
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
    return this.getRecordsNamed(SignetEventName.RespondBidirectionalEvent, requestId);
  }

  /**
   * Fetch the respond-bidirectional posts declared under `requestId` and
   * return the first (oldest) one whose signature verifies against
   * `mpcResponseKey`, provided its attested width and output hash match
   * `serializedOutput`: the off-chain twin of the check the client contract
   * runs in-circuit. The output must be the exact unpadded bytes the
   * attestation commits to, so a post that verifies here is the post that
   * proves at claim time.
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
