// One-stop client-side reader for the signet request/response flow: fetch a
// request record from the requester contract's ledger, enumerate the posts in
// the signet contract's signature response log, and verify each candidate
// against the request.
// This is the helper the Signet.compact "Response Ledger Layout" comment
// promises — the log is UNAUTHENTICATED, so a client must verify every post
// and take the first valid one; this class packages that flow so every
// consumer (CLI poller, integration tests, a future UI) shares one
// implementation. Single-shot by design: each call queries state once; the
// caller owns any poll loop.

import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js-types";
import type { Transaction } from "ethers";

import { readSignetRequestsLedgerFromState } from "./signature-requests-state-reader.ts";
import {
  readSignetContractLedgerFromState,
  signetResponseIndexKey,
  type SignatureResponse,
  type RespondBidirectional,
} from "./signet-contract-state-reader.ts";
import { recoverSignatureResponseSigner } from "./signature-response-verification.ts";
import type { RawContractState } from "./signature-state-reading.ts";
import {
  signBidirectionalRequestToSignedEVMTransaction,
  signBidirectionalRequestToUnsignedEVMTransaction,
  type SignBidirectionalRequest,
  type RequestIdHex,
} from "./signet-requests.ts";

/**
 * The least of midnight-js's `PublicDataProvider` the reader needs: raw
 * contract state by address. Declared structurally (rather than a `Pick`) so
 * tests can satisfy it with a plain stub; any full `PublicDataProvider`
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
  /** Address of the central signet contract. */
  readonly signetContractAddress: string;
  /** Source of raw contract state, e.g. midnight-js's `indexerPublicDataProvider`. */
  readonly publicDataProvider: SignetPublicStateSource;
}

/** The verdict on one posted response, in `count` order. */
export interface SignatureResponseVerdict {
  /** 0-based position of the post in the request's response log. */
  count: bigint;
  /** The posted signature record, verbatim. */
  response: SignatureResponse;
  /** Recovered signer address — absent when the signature did not decode. */
  signer?: string;
  /** Why the post was rejected; absent when the post is valid. */
  rejectedReason?: string;
}

/** Result of {@link SignetRequestResponseReader['getVerifiedSignatureResponse']}. */
export interface VerifiedSignatureResponseResult {
  /**
   * The first valid response (lowest count), or `undefined` when no valid
   * response has been posted yet — poll again.
   */
  verified?: SignatureResponse;
  /**
   * One verdict per post, count order. Pure data: the reader never logs, so
   * callers decide how to surface rejected posts.
   */
  verdicts: SignatureResponseVerdict[];
}

/**
 * Reader over one requester contract / signet contract pair.
 * Construct once per pair and reuse: fetched request records are cached (they
 * are immutable — the ledger key is their hash), so repeated verification
 * calls cost one responses-contract query each.
 */
export class SignetRequestResponseReader {
  private readonly config: SignetRequestResponseReaderConfig;

  // Request records never change once stored; cache them across calls.
  private readonly requestCache = new Map<
    RequestIdHex,
    SignBidirectionalRequest
  >();

  /**
   * @param config - The contract pair and state source to read through.
   */
  constructor(config: SignetRequestResponseReaderConfig) {
    this.config = config;
  }

  /**
   * Query one contract's raw state, throwing a uniform error when absent.
   *
   * @param contractAddress - The contract to query.
   * @param role - Human name of the contract for the error message.
   * @returns The raw ledger state tree.
   * @throws Error when the address holds no contract state.
   */
  private async queryRawState(
    contractAddress: string,
    role: string,
  ): Promise<RawContractState> {
    const state =
      await this.config.publicDataProvider.queryContractState(contractAddress);
    if (!state?.data) {
      throw new Error(
        `no state data found for ${role} contract '${contractAddress}' - is it deployed?`,
      );
    }
    return state.data;
  }

  /**
   * Fetch the request record for `requestId` from the requester contract's
   * ledger (request index, field 0 by the signet layout convention). Cached
   * after the first fetch.
   *
   * @param requestId - The request id to look up.
   * @returns The stored request record.
   * @throws Error when the requester contract has no state or holds no
   *   request under `requestId`.
   */
  async getSignatureRequest(
    requestId: RequestIdHex,
  ): Promise<SignBidirectionalRequest> {
    const cached = this.requestCache.get(requestId);
    if (cached !== undefined) {
      return cached;
    }
    const raw = await this.queryRawState(
      this.config.requesterContractAddress,
      "requester",
    );
    const { requestsIndex } = readSignetRequestsLedgerFromState(raw);
    const request = requestsIndex.get(requestId);
    if (request === undefined) {
      throw new Error(
        `request ${requestId} is not on the requester contract's ledger — was it submitted?`,
      );
    }
    this.requestCache.set(requestId, request);
    return request;
  }

  /**
   * Fetch every response posted for `requestId`, in post (count) order.
   * UNVERIFIED — any of them may be garbage; see
   * {@link getVerifiedSignatureResponse}.
   *
   * @param requestId - The request id whose posts to enumerate.
   * @returns The posted payloads, index = count; empty when none yet.
   * @throws Error when the responses contract has no state, or its counter
   *   disagrees with the log (inconsistent ledger).
   */
  async getSignatureResponses(
    requestId: RequestIdHex,
  ): Promise<SignatureResponse[]> {
    const raw = await this.queryRawState(
      this.config.signetContractAddress,
      "signet contract",
    );
    const { signatureResponseCounterIndex, signatureResponseIndex } =
      readSignetContractLedgerFromState(raw);
    const totalPosts = signatureResponseCounterIndex.get(requestId) ?? 0n;
    const responses: SignatureResponse[] = [];
    for (let count = 0n; count < totalPosts; count++) {
      const response = signatureResponseIndex.get(
        signetResponseIndexKey(requestId, count),
      );
      if (response === undefined) {
        throw new Error(
          `response log has no entry ${count} for request ${requestId} ` +
            `despite its counter reading ${totalPosts} — ledger state is inconsistent`,
        );
      }
      responses.push(response);
    }
    return responses;
  }

  /**
   * Fetch and verify the responses posted for `requestId`: each post's
   * `{ bigR, s, recoveryId }` signature must recover to `expectedSigner`
   * (compared case-insensitively) over the signing hash of the transaction
   * the request record describes. The first valid post wins; every post gets
   * a verdict so callers can report the noise.
   *
   * @param requestId - The request id to fetch a verified response for.
   * @param expectedSigner - The EVM address (0x hex, any case) the genuine
   *   response must be signed by — the requester's MPC-derived address.
   * @returns The first valid response (if any) plus per-post verdicts.
   * @throws Error when either contract has no state, the request is not on
   *   the requester's ledger, or the responses ledger is inconsistent.
   */
  async getVerifiedSignatureResponse(
    requestId: RequestIdHex,
    expectedSigner: string,
  ): Promise<VerifiedSignatureResponseResult> {
    const request = await this.getSignatureRequest(requestId);
    const responses = await this.getSignatureResponses(requestId);
    const verdicts = responses.map(
      (response, index): SignatureResponseVerdict => {
        const count = BigInt(index);
        let signer: string;
        try {
          signer = recoverSignatureResponseSigner(request, response);
        } catch (error) {
          return {
            count,
            response,
            rejectedReason: `not a decodable signature (${String(error)})`,
          };
        }
        if (signer.toLowerCase() !== expectedSigner.toLowerCase()) {
          return {
            count,
            response,
            signer,
            rejectedReason: `signed by ${signer}, expected ${expectedSigner}`,
          };
        }
        return { count, response, signer };
      },
    );
    return {
      verified: verdicts.find((v) => v.rejectedReason === undefined)?.response,
      verdicts,
    };
  }

  /**
   * Rebuild the unsigned EIP-1559 transaction for `requestId` — the exact
   * transaction the MPC signs, assembled from the request record's decomposed
   * fields. No responses-contract query: this needs only the request record
   * (fetched via {@link getSignatureRequest}, cached).
   *
   * @param requestId - The request id whose transaction to rebuild.
   * @returns The unsigned ethers transaction (`unsignedHash` is the MPC's
   *   signing digest).
   * @throws Error when the requester contract has no state or holds no
   *   request under `requestId`.
   */
  async getUnsignedEVMTransaction(
    requestId: RequestIdHex,
  ): Promise<Transaction> {
    return signBidirectionalRequestToUnsignedEVMTransaction(
      await this.getSignatureRequest(requestId),
    );
  }

  /**
   * Assemble the broadcast-ready signed EIP-1559 transaction for `requestId`:
   * rebuild the request's transaction and attach the first VERIFIED response
   * signed by `expectedSigner` (see {@link getVerifiedSignatureResponse} — the
   * response log is unauthenticated, so an `expectedSigner` is required and
   * unverified posts are never attached).
   *
   * @param requestId - The request id to produce a signed transaction for.
   * @param expectedSigner - The EVM address (0x hex, any case) the genuine
   *   response must be signed by — the requester's MPC-derived address.
   * @returns The signed ethers transaction (`serialized` is the payload for
   *   `eth_sendRawTransaction`), or `undefined` when no valid response has
   *   been posted yet — poll again.
   * @throws Error when either contract has no state, the request is not on the
   *   requester's ledger, or the responses ledger is inconsistent.
   */
  async getSignedEVMTransaction(
    requestId: RequestIdHex,
    expectedSigner: string,
  ): Promise<Transaction | undefined> {
    const { verified } = await this.getVerifiedSignatureResponse(
      requestId,
      expectedSigner,
    );
    if (verified === undefined) {
      return undefined;
    }
    // getSignatureRequest is cached — getVerifiedSignatureResponse already
    // fetched it, so this is a free lookup, not a second query.
    const request = await this.getSignatureRequest(requestId);
    return signBidirectionalRequestToSignedEVMTransaction(request, verified);
  }

  /**
   * Fetch the MPC's respond-bidirectional attestation for `requestId`,
   * if posted. The signet contract verified it IN-CIRCUIT at post time
   * (Schnorr over `(requestId, hash(serializedOutput, outputLen))` against
   * the sealed MPC key), so it is single-slot and needs no off-chain
   * verification or verdicts — `undefined` simply means not posted yet, poll
   * again.
   *
   * @param requestId - The request id whose attestation to fetch.
   * @returns The attestation record, or `undefined` when none is posted.
   * @throws Error when the signet contract has no state on-chain.
   */
  async getRespondBidirectional(
    requestId: RequestIdHex,
  ): Promise<RespondBidirectional | undefined> {
    const raw = await this.queryRawState(
      this.config.signetContractAddress,
      "signet contract",
    );
    return readSignetContractLedgerFromState(raw).respondBidirectionalIndex.get(
      requestId,
    );
  }
}
