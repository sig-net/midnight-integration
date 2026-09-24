// MPC-/client-style decoders for the central SIGNET contract's emitted
// events. Every signet contract circuit emits one `Misc` contract event
// (MIP-0002 public log emission) whose 32-byte name tags the event kind and
// whose 256-byte payload packs the record:
//   SignBidirectionalEvent    - version (1) ++ requestId (32) ++ notification payload (128) ++ zeros (95)
//   SignatureRespondedEvent   - requestId (32) ++ bigR.x (32) ++ bigR.y (32) ++ s (32) ++ recoveryId (1) ++ zeros (127)
//   RespondBidirectionalEvent - requestId (32) ++ blockHeight (8, little-endian) ++ outputKind (1)
//                               ++ serializedOutputLength (8, little-endian) ++ digest (32)
//                               ++ bigR.x (32) ++ bigR.y (32) ++ s (32) ++ recoveryId (1) ++ zeros (78)
// The decoders here are the byte-plumbing twins of the emit literals in
// signet-contract.compact: field order and offsets must match byte-for-byte
// (the signet-contract simulator tests pin the lockstep against real emits).
// Every event is UNAUTHENTICATED: verification is the reader's job. The
// request id every payload discloses is routing data only, so it scopes
// reads to one request and proves nothing.

import { CompactTypeBytes, type LogEvent } from "@midnight-ntwrk/compact-runtime";

import { bytesToBigint, bytesToHex, hexToBytes } from "./byte-codecs.ts";
import { decodeExactly } from "./compact-descriptors.ts";
import { asciiUnpadded } from "./constants.ts";
import { OutputKind } from "./managed/contract/index.js";
import { contractAddressFromHex, type RequestIdHex, requestIdHex } from "./signet-requests.ts";

/**
 * The event names the signet contract emits, exactly as the contract's
 * `emit` literals spell them (the on-wire name is this string NUL-padded to
 * {@link SIGNET_EVENT_NAME_LENGTH} bytes, see {@link decodeSignetEventName}).
 */
export enum SignetEventName {
  /** A client's cross-contract signature-request notification. */
  SignBidirectionalEvent = "SignBidirectionalEvent",
  /** The MPC's signature response to a request. */
  SignatureRespondedEvent = "SignatureRespondedEvent",
  /** The MPC's respond-bidirectional attestation of a foreign execution. */
  RespondBidirectionalEvent = "RespondBidirectionalEvent",
}

/** Byte width of a signet event's name (Compact `pad(32, ...)`). */
export const SIGNET_EVENT_NAME_LENGTH = 32;

/** Byte width of every signet event's packed payload. */
export const SIGNET_EVENT_PAYLOAD_LENGTH = 256;

/**
 * A signet contract event in decoded form: the NUL-trimmed name and the full
 * re-padded {@link SIGNET_EVENT_PAYLOAD_LENGTH}-byte payload. The one shape
 * every source normalises to before the per-event payload decoders run.
 */
export interface SignetMiscEvent {
  /** The event name, NUL padding stripped (compare to {@link SignetEventName}). */
  name: string;
  /** The packed payload, re-padded to {@link SIGNET_EVENT_PAYLOAD_LENGTH} bytes. */
  payload: Uint8Array;
}

/**
 * A {@link SignetMiscEvent} read through the indexer, carrying the indexer's
 * event cursor and where on chain the event was emitted, so a consumer can
 * dedup, resume, show progress against the tip, say when the event happened
 * and link it to its transaction. The simulator path
 * ({@link decodeSignetLogEvents}) has none of this and yields plain
 * {@link SignetMiscEvent}s.
 */
export interface IndexedSignetMiscEvent extends SignetMiscEvent {
  /** The indexer's global event cursor, ascending in emission order. */
  id: number;
  /** The highest event id the indexer knew when the event's page was served. */
  maxId: number;
  /** Indexer row id of the emitting transaction. For the chain's id see {@link transactionHash}. */
  transactionId: number;
  /** Hash of the emitting transaction, lowercase hex, no `0x` prefix. */
  transactionHash: string;
  /** Height of the block holding the emitting transaction. */
  blockHeight: number;
  /** Hash of that block, lowercase hex, no `0x` prefix. */
  blockHash: string;
  /** When that block was produced. */
  blockTimestamp: Date;
}

/**
 * Source of the signet contract's emitted events, the event-side sibling of
 * `SignetPublicStateSource`. Structural, so tests can stub it with a stream
 * over fixtures. Read a live indexer with {@link signetEventSourceFromIndexer},
 * which yields {@link IndexedSignetMiscEvent}s.
 */
export interface SignetEventSource<TEvent extends SignetMiscEvent = SignetMiscEvent> {
  /**
   * Stream every signet event the contract has emitted so far, oldest
   * first. Events arrive one indexer page at a time: a page's events are
   * yielded before the next page is requested, so a consumer sees progress
   * per page, and leaving the `for await` loop early stops further requests.
   *
   * @param contractAddress - The signet contract to read events of.
   * @returns The decoded events, oldest first.
   */
  streamSignetEvents(contractAddress: string): AsyncIterable<TEvent>;
}

/** Descriptor re-padding a name ++ payload event atom to its full width. */
const eventBytes = new CompactTypeBytes(SIGNET_EVENT_NAME_LENGTH + SIGNET_EVENT_PAYLOAD_LENGTH);

/**
 * Whether a decoded event carries `name`.
 *
 * A decoded event's `name` comes from arbitrary on-chain bytes, so it is a
 * plain string and NOT the enum. Comparing the two directly is what
 * `no-unsafe-enum-comparison` exists to catch, and it is right to: the
 * widening belongs here, once, rather than at every call site.
 *
 * @param event - The decoded signet event.
 * @param event.name - Its decoded, NUL-stripped event name.
 * @param name - The event name to match.
 * @returns Whether the event's decoded name equals `name`.
 */
export function isSignetEventNamed(event: { name: string }, name: SignetEventName): boolean {
  return event.name === (name as string);
}

/**
 * Decode a fixed-width event name: the inverse of the contract's
 * `pad(32, "...")`.
 *
 * @param name - The padded name bytes.
 * @returns The trimmed name string.
 */
export function decodeSignetEventName(name: Uint8Array): string {
  return asciiUnpadded(name);
}

/**
 * Decode the simulator's circuit-execution log into signet events. For
 * simulator tests. The indexer-path counterpart is
 * {@link signetEventSourceFromIndexer}.
 *
 * @param events - The `context.events` of a `CircuitResults`.
 * @param contractAddress - Optional filter: only events this contract emitted.
 * @returns The decoded events, in emission order.
 * @throws {Error} When a `misc` event is not a single bytes atom of the signet
 *   name ++ payload width.
 */
export function decodeSignetLogEvents(
  events: readonly LogEvent[],
  contractAddress?: string,
): SignetMiscEvent[] {
  const out: SignetMiscEvent[] = [];
  for (const event of events) {
    if (event.eventType !== "misc") continue;
    if (contractAddress !== undefined && event.address !== contractAddress) {
      continue;
    }
    if (event.data.tag !== "cell") {
      throw new Error(`misc event data is a '${event.data.tag}', expected a cell`);
    }
    // fromValue re-pads the trailing zeros the state layer trims.
    const bytes = decodeExactly(eventBytes, event.data.content.value, "misc event data");
    out.push({
      name: decodeSignetEventName(bytes.slice(0, SIGNET_EVENT_NAME_LENGTH)),
      payload: bytes.slice(SIGNET_EVENT_NAME_LENGTH),
    });
  }
  return out;
}

/** Where {@link signetEventSourceFromIndexer} reads the signet contract's events from. */
export interface SignetIndexerConfig {
  /** The indexer's GraphQL query endpoint over HTTP, e.g. `https://<indexer>/api/v4/graphql`. */
  readonly queryUrl: string;
}

/**
 * The events query, written against the indexer v4 schema. It selects the
 * `transaction` relation, which is what carries the emitting transaction's
 * hash and its block.
 */
const SIGNET_CONTRACT_EVENTS_QUERY = `
  query SignetContractEvents($filter: ContractEventFilter!, $limit: Int, $offset: Int) {
    contractEvents(filter: $filter, limit: $limit, offset: $offset) {
      __typename
      id
      maxId
      transactionId
      transaction { hash block { height hash timestamp } }
      ... on MiscContractEvent { name payload }
    }
  }
`;

/** The `__typename` of the one contract event variant the signet contract emits. */
const MISC_CONTRACT_EVENT_TYPENAME = "MiscContractEvent";

/** Events requested per page: the page size midnight-js's own contract events query defaults to. */
const EVENT_PAGE_LIMIT = 100;

/**
 * One `contractEvents` row as the indexer's JSON carries it. Every field is
 * optional: the wire is external input until {@link signetMiscEventFromIndexerRow}
 * has checked it.
 */
interface IndexerContractEventRow {
  /** The GraphQL type of the row: the event variant. */
  __typename?: string;
  /** The indexer's global event cursor. */
  id?: number;
  /** The highest event id the indexer knew when the page was served. */
  maxId?: number;
  /** Indexer row id of the emitting transaction. */
  transactionId?: number;
  /** The emitting transaction. */
  transaction?: {
    /** The transaction hash, hex encoded. */
    hash?: string;
    /** The block holding the transaction. */
    block?: {
      /** The block height. */
      height?: number;
      /** The block hash, hex encoded. */
      hash?: string;
      /** When the block was produced, epoch milliseconds. */
      timestamp?: number;
    };
  };
  /** A `Misc` event's name, hex encoded. */
  name?: string;
  /** A `Misc` event's payload, hex encoded, trailing zeros trimmed. */
  payload?: string;
}

/**
 * Normalise one indexer row into a signet event: the name NUL-trimmed and
 * the payload re-padded to the full {@link SIGNET_EVENT_PAYLOAD_LENGTH}
 * (the indexer trims a stored atom's trailing zeros).
 *
 * @param row - The row as the indexer served it.
 * @returns The signet event, or `undefined` when the row is not a `Misc` event.
 * @throws {Error} When a `Misc` row lacks a field the query selects, or its
 *   name or payload is not a hex byte string.
 */
function signetMiscEventFromIndexerRow(
  row: IndexerContractEventRow,
): IndexedSignetMiscEvent | undefined {
  if (row.__typename !== MISC_CONTRACT_EVENT_TYPENAME) return undefined;
  const { id, maxId, transactionId, name, payload } = row;
  const transactionHash = row.transaction?.hash;
  const block = row.transaction?.block;
  if (
    id === undefined ||
    maxId === undefined ||
    transactionId === undefined ||
    name === undefined ||
    payload === undefined ||
    transactionHash === undefined ||
    block?.height === undefined ||
    block.hash === undefined ||
    block.timestamp === undefined
  ) {
    throw new Error(`the indexer served a malformed Misc contract event: ${JSON.stringify(row)}`);
  }
  const padded = new Uint8Array(SIGNET_EVENT_PAYLOAD_LENGTH);
  padded.set(hexToBytes(payload).slice(0, SIGNET_EVENT_PAYLOAD_LENGTH), 0);
  return {
    name: decodeSignetEventName(hexToBytes(name)),
    payload: padded,
    id,
    maxId,
    transactionId,
    transactionHash,
    blockHeight: block.height,
    blockHash: block.hash,
    blockTimestamp: new Date(block.timestamp),
  };
}

/** The indexer's answer to {@link SIGNET_CONTRACT_EVENTS_QUERY}: the GraphQL response envelope. */
interface IndexerContractEventsResponse {
  /** The query result, absent or null when the query failed. */
  data?: {
    /** The page of events. */
    contractEvents?: IndexerContractEventRow[];
  } | null;
  /** What the indexer rejected, e.g. a contract address that is not hex. */
  errors?: {
    /** The rejection, in the indexer's words. */
    message?: string;
  }[];
}

/**
 * Fetch one page of a contract's `Misc` events from the indexer.
 *
 * @param queryUrl - The indexer's GraphQL query endpoint.
 * @param contractAddress - The contract whose events to read.
 * @param offset - Events to skip from the start of the history.
 * @returns The page's rows, oldest first.
 * @throws {Error} When the indexer cannot be reached, answers a status other
 *   than 200, rejects the query, or answers without a page.
 */
async function fetchContractEventPage(
  queryUrl: string,
  contractAddress: string,
  offset: number,
): Promise<IndexerContractEventRow[]> {
  const response = await fetch(queryUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: SIGNET_CONTRACT_EVENTS_QUERY,
      variables: {
        filter: { contractAddress, types: ["MISC"] },
        limit: EVENT_PAGE_LIMIT,
        offset,
      },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `indexer answered HTTP ${String(response.status)} for ${queryUrl}: ${await response.text()}`,
    );
  }
  const body = (await response.json()) as IndexerContractEventsResponse;
  if (body.errors !== undefined && body.errors.length > 0) {
    const messages = body.errors.map((error) => error.message ?? "unspecified error");
    throw new Error(`indexer rejected the contract events query: ${messages.join(", ")}`);
  }
  const page = body.data?.contractEvents;
  if (page === undefined) {
    throw new Error(`indexer answered the contract events query without a page: ${queryUrl}`);
  }
  return page;
}

/**
 * Read the signet contract's events from a Midnight indexer. The stream
 * pages the indexer by offset and pins its end to the tip (`maxId`) of the
 * first page, so the walk is a point-in-time snapshot that ends even while
 * the contract keeps emitting: rows past that tip are dropped. The contract
 * address is parsed with {@link contractAddressFromHex} before the first
 * request, so a malformed one fails without a round trip, and a `0x`
 * prefixed one reaches the indexer as the bare hex it expects.
 *
 * @param config - Where the indexer is.
 * @returns The event source.
 */
export function signetEventSourceFromIndexer(
  config: SignetIndexerConfig,
): SignetEventSource<IndexedSignetMiscEvent> {
  return {
    async *streamSignetEvents(contractAddress) {
      const address = bytesToHex(contractAddressFromHex(contractAddress).bytes);
      let tipId: number | undefined;
      for (let offset = 0; ; offset += EVENT_PAGE_LIMIT) {
        const page = await fetchContractEventPage(config.queryUrl, address, offset);
        for (const row of page) {
          const event = signetMiscEventFromIndexerRow(row);
          if (event === undefined) continue;
          tipId ??= event.maxId;
          if (event.id > tipId) return;
          yield event;
        }
        if (page.length < EVENT_PAGE_LIMIT) return;
      }
    },
  };
}

/**
 * A curve point in affine coordinates (Compact `AffinePoint`), SEC1
 * big-endian, the same shape the sig-net EVM and Solana signer contracts
 * expose.
 */
export interface AffinePoint {
  /** The x coordinate, 32 big-endian bytes. */
  x: Uint8Array;
  /** The y coordinate, 32 big-endian bytes. */
  y: Uint8Array;
}

/**
 * The MPC's canonical ECDSA signature as both respond events carry it
 * (Compact `Signature`, matching the MPC's own
 * `Signature { big_r, s, recovery_id }` and the EVM/Solana signer
 * contracts). Emitted UNVERIFIED. Decode to an ethers signature with
 * `signatureRespondedEventToSignature`. Tests mint records with the
 * `@sig-net/midnight/testing` entry point's `ecdsaSignatureToMpcSignature`.
 */
export interface MpcSignature {
  /** The signature's nonce point R. */
  bigR: AffinePoint;
  /** Signature scalar s, 32 big-endian bytes. */
  s: Uint8Array;
  /** Recovery id (parity of R.y): 0 or 1. */
  recoveryId: bigint;
}

/**
 * The MPC's signature over the requested EVM transaction (Compact
 * `SignatureRespondedEventV1`). Emitted UNVERIFIED: authenticity comes from
 * `SignetRequestResponseReader.getVerifiedSignatureRespondedEvent`.
 */
export interface SignatureRespondedEvent {
  /** The request this signature answers, 32 bytes. Routing data only. */
  requestId: Uint8Array;
  /** The requested signature over the transaction the request describes. */
  signature: MpcSignature;
}

/**
 * The MPC's respond-bidirectional attestation of a request's remote EVM
 * execution (Compact `RespondBidirectionalEventV1`, in declaration order): the
 * ECDSA signature over the attestation digest
 * (`calculateSignetAttestationDigest`) with everything that digest commits to
 * except the output, which travels off chain. Emitted UNVERIFIED: verify
 * in-circuit via `verifyRespondBidirectionalEventV1` or off chain via
 * `verifyRespondBidirectionalSignature`. Mint one with the
 * `@sig-net/midnight/testing` entry point's `attestRespondBidirectional`.
 */
export interface RespondBidirectionalEvent {
  /**
   * The request this attestation answers, 32 bytes. Routing data: a
   * verifier hashes the id the client presents.
   */
  requestId: Uint8Array;
  /**
   * Height of the finalised destination block holding the attested
   * transaction, in the destination chain's own numbering (a slot on
   * Solana). Compact `Uint<64>`, signed into the digest.
   */
  blockHeight: bigint;
  /** The MPC's verdict on the execution, signed into the digest. */
  outputKind: OutputKind;
  /**
   * Byte width of the serialised output the digest commits to, 0 for a
   * failed or unviable execution. Compact `Uint<64>`.
   */
  serializedOutputLength: bigint;
  /**
   * The attestation digest the signature is over, 32 bytes: lets a reader
   * with no output in hand check the signature. A verifier recomputes it.
   */
  digest: Uint8Array;
  /** ECDSA signature over the attestation digest. */
  signature: MpcSignature;
}

/**
 * A decoded signet event payload: the request id the emitting circuit
 * disclosed beside the posted record. The id is UNAUTHENTICATED routing
 * data: it scopes reads to one request and proves nothing. Each record
 * type's own doc names its authenticity check.
 */
export interface SignetEventPost<TRecord> {
  /** The request id the post declares it concerns, 32 bytes. Routing data only. */
  requestId: Uint8Array;
  /** The posted record, verbatim. */
  event: TRecord;
}

/** Byte width of a packed `Signature`: bigR.x (32) ++ bigR.y (32) ++ s (32) ++ recoveryId (1). */
const PACKED_SIGNATURE_LENGTH = 97;

/**
 * Unpack the `Signature` leaves both respond payloads carry, starting at
 * `offset`: bigR.x (32) ++ bigR.y (32) ++ s (32) ++ recoveryId (1).
 *
 * @param payload - The full event payload.
 * @param offset - Where the packed signature starts.
 * @returns The decoded signature.
 * @throws {Error} When the payload is too short to hold the packed signature.
 */
function decodeSignatureAt(payload: Uint8Array, offset: number): MpcSignature {
  const recoveryId = payload[offset + PACKED_SIGNATURE_LENGTH - 1];
  if (recoveryId === undefined) {
    throw new Error(
      `signet event payload of ${String(payload.length)} bytes is too short for a packed respond record`,
    );
  }
  return {
    bigR: {
      x: payload.slice(offset, offset + 32),
      y: payload.slice(offset + 32, offset + 64),
    },
    s: payload.slice(offset + 64, offset + 96),
    recoveryId: BigInt(recoveryId),
  };
}

/** Offsets of a signature response payload's leaves, in emit order. */
const SIGNATURE_RESPONDED_REQUEST_ID_OFFSET = 0;
const SIGNATURE_RESPONDED_SIGNATURE_OFFSET = 32;

/**
 * Decode a {@link SignetEventName.SignatureRespondedEvent} payload: the
 * decode twin of the `respond` circuit's emit literal.
 *
 * @param payload - The event's payload.
 * @returns The decoded post: declared request id plus record.
 * @throws {Error} When the payload is too short to hold the packed leaves.
 */
export function decodeSignatureRespondedEventPayload(
  payload: Uint8Array,
): SignetEventPost<SignatureRespondedEvent> {
  const signature = decodeSignatureAt(payload, SIGNATURE_RESPONDED_SIGNATURE_OFFSET);
  const requestId = payload.slice(
    SIGNATURE_RESPONDED_REQUEST_ID_OFFSET,
    SIGNATURE_RESPONDED_SIGNATURE_OFFSET,
  );
  return { requestId, event: { requestId, signature } };
}

/** Offsets of a respond-bidirectional payload's leaves, in emit order. */
const RESPOND_BIDIRECTIONAL_REQUEST_ID_OFFSET = 0;
const RESPOND_BIDIRECTIONAL_BLOCK_HEIGHT_OFFSET = 32;
const RESPOND_BIDIRECTIONAL_OUTPUT_KIND_OFFSET = 40;
const RESPOND_BIDIRECTIONAL_OUTPUT_LENGTH_OFFSET = 41;
const RESPOND_BIDIRECTIONAL_DIGEST_OFFSET = 49;
const RESPOND_BIDIRECTIONAL_SIGNATURE_OFFSET = 81;

/** Byte width of a packed `Uint<64>` (Compact's `as Bytes<8>` cast, little-endian). */
const PACKED_UINT_64_LENGTH = 8;

/**
 * The output kinds by the variant index Compact's `as Uint<8>` cast of the
 * enum emits, in declaration order: the wire byte is the position here.
 */
const OUTPUT_KIND_BY_VARIANT_INDEX: readonly OutputKind[] = [
  OutputKind.executed,
  OutputKind.failed,
  OutputKind.unviable,
];

/**
 * Narrow a payload byte to an {@link OutputKind}.
 *
 * @param byte - The packed output kind byte.
 * @returns The output kind.
 * @throws {Error} When the byte names no variant.
 */
function outputKindOf(byte: number): OutputKind {
  const kind = OUTPUT_KIND_BY_VARIANT_INDEX[byte];
  if (kind === undefined) {
    throw new Error(`signet event payload carries an unknown output kind ${String(byte)}`);
  }
  return kind;
}

/**
 * Decode a {@link SignetEventName.RespondBidirectionalEvent} payload: the
 * decode twin of the `respondBidirectional` circuit's emit literal. The two
 * `Uint<64>` leaves are 8 little-endian bytes each, the byte order of
 * Compact's `Uint<64>` to `Bytes<8>` cast.
 *
 * @param payload - The event's payload.
 * @returns The decoded post: declared request id plus record.
 * @throws {Error} When the payload is too short to hold the packed leaves or
 *   its output kind byte names no variant.
 */
export function decodeRespondBidirectionalEventPayload(
  payload: Uint8Array,
): SignetEventPost<RespondBidirectionalEvent> {
  const signature = decodeSignatureAt(payload, RESPOND_BIDIRECTIONAL_SIGNATURE_OFFSET);
  const kindByte = payload[RESPOND_BIDIRECTIONAL_OUTPUT_KIND_OFFSET];
  if (kindByte === undefined) {
    throw new Error("the signature decode above proves this is unreachable");
  }
  const requestId = payload.slice(
    RESPOND_BIDIRECTIONAL_REQUEST_ID_OFFSET,
    RESPOND_BIDIRECTIONAL_BLOCK_HEIGHT_OFFSET,
  );
  return {
    requestId,
    event: {
      requestId,
      blockHeight: bytesToBigint(
        payload.subarray(
          RESPOND_BIDIRECTIONAL_BLOCK_HEIGHT_OFFSET,
          RESPOND_BIDIRECTIONAL_BLOCK_HEIGHT_OFFSET + PACKED_UINT_64_LENGTH,
        ),
      ),
      outputKind: outputKindOf(kindByte),
      serializedOutputLength: bytesToBigint(
        payload.subarray(
          RESPOND_BIDIRECTIONAL_OUTPUT_LENGTH_OFFSET,
          RESPOND_BIDIRECTIONAL_OUTPUT_LENGTH_OFFSET + PACKED_UINT_64_LENGTH,
        ),
      ),
      digest: payload.slice(
        RESPOND_BIDIRECTIONAL_DIGEST_OFFSET,
        RESPOND_BIDIRECTIONAL_SIGNATURE_OFFSET,
      ),
      signature,
    },
  };
}

/**
 * Raw twin of the Compact `SignBidirectionalEventNotification` struct as the
 * `signBidirectional` circuit emits it: the version tag plus the still-packed
 * 128-byte payload. Decode the payload with
 * {@link decodeSignBidirectionalNotification}.
 */
export interface SignBidirectionalNotificationRecord {
  /** Payload layout tag (Compact `Uint<8>`): 1 = the V1 layout. */
  version: bigint;
  /** The packed payload bytes, exactly as the registering circuit built them. */
  payload: Uint8Array;
}

/** Offset of the notification's version tag in the event payload. */
const NOTIFICATION_EVENT_VERSION_OFFSET = 0;

/** Offset of the declared request id in the event payload. */
const NOTIFICATION_EVENT_REQUEST_ID_OFFSET = 1;

/** Offset of the packed notification payload in the event payload. */
const NOTIFICATION_EVENT_PAYLOAD_OFFSET = 33;

/** Byte width of the packed notification payload (Compact `Bytes<128>`). */
const NOTIFICATION_PAYLOAD_LENGTH = 128;

/**
 * Decode a {@link SignetEventName.SignBidirectionalEvent} payload into the
 * declared request id and the raw notification record: the decode twin of
 * the `signBidirectional` circuit's emit literal
 * (version (1) ++ requestId (32) ++ notification payload (128)).
 *
 * @param payload - The event's payload.
 * @returns The decoded post: declared request id plus raw notification record.
 * @throws {Error} When the payload is too short to hold the record.
 */
export function decodeSignBidirectionalEventNotificationPayload(
  payload: Uint8Array,
): SignetEventPost<SignBidirectionalNotificationRecord> {
  const version = payload[NOTIFICATION_EVENT_VERSION_OFFSET];
  const end = NOTIFICATION_EVENT_PAYLOAD_OFFSET + NOTIFICATION_PAYLOAD_LENGTH;
  if (version === undefined || payload.length < end) {
    throw new Error(
      `signet event payload of ${String(payload.length)} bytes is too short for a packed notification`,
    );
  }
  return {
    requestId: payload.slice(
      NOTIFICATION_EVENT_REQUEST_ID_OFFSET,
      NOTIFICATION_EVENT_PAYLOAD_OFFSET,
    ),
    event: {
      version: BigInt(version),
      payload: payload.slice(NOTIFICATION_EVENT_PAYLOAD_OFFSET, end),
    },
  };
}

/** Offset of the V1 `callerAddress` in the packed payload (`Bytes<32>` at the front). */
const NOTIFICATION_CALLER_ADDRESS_OFFSET = 0;

/** Offset of the V1 `requestsPathDepth` (after the 32 callerAddress bytes). */
const NOTIFICATION_PATH_DEPTH_OFFSET = 32;

/** Offset of the V1 `requestsPath` bytes (after the 1-byte depth). */
const NOTIFICATION_PATH_OFFSET = 33;

/**
 * Maximum ledger-tree path depth the V1 payload carries, matching the
 * `Vector<4, Uint<8>>` the `constructSignBidirectionalEventNotificationV1`
 * circuit packs.
 */
const MAX_LEDGER_PATH_DEPTH = 4;

/** The only payload interpretation {@link decodeSignBidirectionalNotification} understands today. */
const SUPPORTED_NOTIFICATION_VERSION = 1n;

/**
 * A decoded V1 notification: the flat pointer a client emitted to tell the
 * MPC a request was stored, and WHERE to read the authenticated copy
 * (resolve with `lookupSignetRequestAt`). The fields themselves confer no
 * authority.
 */
export interface SignBidirectionalNotification {
  /**
   * Payload layout tag, the literal of the one layout this decoder produces.
   * A second layout joins as its own interface with its own literal, making
   * the decoded notification a union discriminated on `version`, so every
   * consumer gets a compile error where it must handle the new layout. Keep
   * this a literal: widening it to `number` gives that error away.
   */
  version: 1;
  /**
   * Address of the contract whose request map holds the request, rendered
   * as lowercase hex, no `0x` prefix: directly usable as a
   * `queryContractState` argument.
   */
  callerAddress: string;
  /**
   * Resolved ledger-tree path of the `SignBidirectionalEventMapV1` in
   * {@link callerAddress}, as compactc records it in that contract's
   * `contract-info.json` (`"index"`): `[4]` for a flat contract's field 4,
   * `[1, 14]` once chunking applies. Followed node for node by
   * `signetFieldNodeByPath`.
   */
  requestsPath: number[];
}

/**
 * Unpack a {@link SignBidirectionalNotificationRecord}'s payload by the
 * fixed V1 offsets: the decode twin of the compiled
 * `constructSignBidirectionalEventNotificationV1` circuit (the pack↔decode
 * lockstep is pinned by a unit test round-tripping through the real
 * circuit). V1 layout:
 * callerAddress (32) ++ requestsPathDepth (1) ++ requestsPath (4) ++ zero
 * padding (91), where only the first `requestsPathDepth` path bytes are
 * meaningful. Fails closed on an unrecognised `version`.
 *
 * @param record - The raw notification record.
 * @returns The decoded notification, its `requestsPath` trimmed to the
 *   declared depth.
 * @throws {Error} If the record's `version` is not one this decoder understands,
 *   or its `requestsPathDepth` is zero or exceeds {@link MAX_LEDGER_PATH_DEPTH}.
 */
export function decodeSignBidirectionalNotification(
  record: SignBidirectionalNotificationRecord,
): SignBidirectionalNotification {
  if (record.version !== SUPPORTED_NOTIFICATION_VERSION) {
    throw new Error(
      `SignBidirectionalEventNotification version ${String(record.version)} is not supported ` +
        `(this decoder understands version ${String(SUPPORTED_NOTIFICATION_VERSION)})`,
    );
  }
  const callerAddress = bytesToHex(
    record.payload.slice(NOTIFICATION_CALLER_ADDRESS_OFFSET, NOTIFICATION_PATH_DEPTH_OFFSET),
  );
  const depth = record.payload[NOTIFICATION_PATH_DEPTH_OFFSET];
  if (depth === undefined || depth < 1 || depth > MAX_LEDGER_PATH_DEPTH) {
    throw new Error(
      `SignBidirectionalEventNotification requestsPathDepth ${String(depth)} is out of range ` +
        `(expected 1 to ${String(MAX_LEDGER_PATH_DEPTH)})`,
    );
  }
  // payload is a re-padded Bytes<128> and depth is bounded to MAX_LEDGER_PATH_DEPTH
  // above, so this slice always yields exactly `depth` bytes.
  const requestsPath = Array.from(
    record.payload.slice(NOTIFICATION_PATH_OFFSET, NOTIFICATION_PATH_OFFSET + depth),
  );
  return {
    version: 1,
    callerAddress,
    requestsPath,
  };
}

/**
 * The decoded record each signet event kind posts, keyed by the event's
 * name: what {@link DecodedSignetEventNamed} carries as `record`.
 */
export interface SignetEventRecords {
  /** The flat pointer to the stored request (the notification fully decoded). */
  [SignetEventName.SignBidirectionalEvent]: SignBidirectionalNotification;
  /** The MPC's signature over the requested transaction. */
  [SignetEventName.SignatureRespondedEvent]: SignatureRespondedEvent;
  /** The MPC's attestation of the foreign execution. */
  [SignetEventName.RespondBidirectionalEvent]: RespondBidirectionalEvent;
}

/**
 * A signet event of kind `TName` in decoded form: a discriminated union over
 * `name`, so narrowing on it narrows `record`. `TEvent` is the shape the
 * event was read in, so an {@link IndexedSignetMiscEvent} keeps its indexer
 * cursor across the decode. Everything here is UNAUTHENTICATED: each record
 * type's own doc names its authenticity check. A shared `requestId` links
 * nothing by itself: events grouped by it are a request, signature and
 * attestation lifecycle only once the request is read from the caller's own
 * ledger with `lookupSignetRequestAt` and each post verifies against it.
 */
export type DecodedSignetEventNamed<
  TName extends SignetEventName,
  TEvent extends SignetMiscEvent = SignetMiscEvent,
> = {
  [Name in TName]: {
    /** The event kind: the discriminant `record` narrows on. */
    name: Name;
    /** The request id the post declares it concerns. Routing data only. */
    requestId: RequestIdHex;
    /** The posted record, decoded. */
    record: SignetEventRecords[Name];
    /** The event as its source served it: the undecoded payload, and the cursor when indexed. */
    source: TEvent;
  };
}[TName];

/** A signet event of any kind in decoded form: see {@link DecodedSignetEventNamed}. */
export type DecodedSignetEvent<TEvent extends SignetMiscEvent = SignetMiscEvent> =
  DecodedSignetEventNamed<SignetEventName, TEvent>;

/** The payload decoder of each signet event kind, each yielding that kind's decoded record. */
const SIGNET_EVENT_PAYLOAD_DECODERS: {
  [Name in SignetEventName]: (payload: Uint8Array) => SignetEventPost<SignetEventRecords[Name]>;
} = {
  [SignetEventName.SignBidirectionalEvent]: (payload) => {
    const post = decodeSignBidirectionalEventNotificationPayload(payload);
    return { requestId: post.requestId, event: decodeSignBidirectionalNotification(post.event) };
  },
  [SignetEventName.SignatureRespondedEvent]: decodeSignatureRespondedEventPayload,
  [SignetEventName.RespondBidirectionalEvent]: decodeRespondBidirectionalEventPayload,
};

/**
 * Decode `event` as the signet event kind `name`, or skip it when it carries
 * another name. The name is checked BEFORE the payload is touched, which is
 * what a reader of one kind needs: the signet contract is unauthenticated,
 * so anyone can emit an undecodable event of another kind, and that must not
 * fail a read that never asked for it.
 *
 * @param event - The signet event as its source served it.
 * @param name - The event kind to decode.
 * @returns The decoded event, or `undefined` when `event` is not a `name` event.
 * @throws {Error} When `event` is a `name` event whose payload does not decode
 *   (see the payload decoder of that kind).
 */
export function decodeSignetEventNamed<
  TName extends SignetEventName,
  TEvent extends SignetMiscEvent,
>(event: TEvent, name: TName): DecodedSignetEventNamed<TName, TEvent> | undefined {
  if (!isSignetEventNamed(event, name)) return undefined;
  const post = SIGNET_EVENT_PAYLOAD_DECODERS[name](event.payload);
  return { name, requestId: requestIdHex(post.requestId), record: post.event, source: event };
}

/**
 * Decode `event` by whichever signet event name it carries. What to do with
 * an event that is not a signet event, or that does not decode, is the
 * caller's policy: a responder skips both, an explorer shows both.
 *
 * WARNING: this THROWS on input anyone can put on chain. The signet contract
 * is unauthenticated, so a `SignBidirectionalEvent` with an unsupported
 * version or a zero path depth costs its sender one transaction. A loop over
 * a live stream must catch, or use {@link tryDecodeSignetEvent}.
 *
 * @param event - The signet event as its source served it.
 * @returns The decoded event, or `undefined` when `event`'s name is not a
 *   {@link SignetEventName}.
 * @throws {Error} When the named kind's payload does not decode.
 */
export function decodeSignetEvent<TEvent extends SignetMiscEvent>(
  event: TEvent,
): DecodedSignetEvent<TEvent> | undefined {
  for (const name of Object.values(SignetEventName)) {
    const decoded = decodeSignetEventNamed(event, name);
    if (decoded !== undefined) return decoded;
  }
  return undefined;
}

/**
 * The outcome of {@link tryDecodeSignetEvent} on a signet event: the decoded
 * event, or the event that did not decode beside the decoder's reason.
 */
export type SignetEventDecodeResult<TEvent extends SignetMiscEvent = SignetMiscEvent> =
  | {
      /** The payload decoded. */
      ok: true;
      /** The decoded event. */
      event: DecodedSignetEvent<TEvent>;
    }
  | {
      /** The payload did not decode. */
      ok: false;
      /** The event as its source served it. */
      source: TEvent;
      /** The payload decoder's error message. */
      reason: string;
    };

/**
 * {@link decodeSignetEvent} without the throw: an undecodable payload comes
 * back as a result to inspect. It reports the failure and leaves the policy
 * (skip it, show it, count it) to the caller.
 *
 * @param event - The signet event as its source served it.
 * @returns The decode result, or `undefined` when `event`'s name is not a
 *   {@link SignetEventName}.
 */
export function tryDecodeSignetEvent<TEvent extends SignetMiscEvent>(
  event: TEvent,
): SignetEventDecodeResult<TEvent> | undefined {
  try {
    const decoded = decodeSignetEvent(event);
    return decoded === undefined ? undefined : { ok: true, event: decoded };
  } catch (error) {
    return {
      ok: false,
      source: event,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Each signet event kind's record selector: the record of a decoded event of that kind. */
const SIGNET_EVENT_RECORD_SELECTORS: {
  [Name in SignetEventName]: (event: DecodedSignetEvent) => SignetEventRecords[Name] | undefined;
} = {
  [SignetEventName.SignBidirectionalEvent]: (event) =>
    event.name === SignetEventName.SignBidirectionalEvent ? event.record : undefined,
  [SignetEventName.SignatureRespondedEvent]: (event) =>
    event.name === SignetEventName.SignatureRespondedEvent ? event.record : undefined,
  [SignetEventName.RespondBidirectionalEvent]: (event) =>
    event.name === SignetEventName.RespondBidirectionalEvent ? event.record : undefined,
};

/**
 * The records of kind `name` that declare `requestId`, out of decoded events
 * already in hand, in the order given. The routing step of every per-request
 * read: it selects by the UNAUTHENTICATED declared id and verifies nothing.
 *
 * @param events - Decoded signet events of any kinds.
 * @param name - The event kind to keep.
 * @param requestId - The request id the kept events must declare.
 * @returns The kept events' records.
 */
export function signetEventRecordsOf<TName extends SignetEventName>(
  events: readonly DecodedSignetEvent[],
  name: TName,
  requestId: RequestIdHex,
): SignetEventRecords[TName][] {
  const records: SignetEventRecords[TName][] = [];
  for (const event of events) {
    if (event.requestId !== requestId) continue;
    const record = SIGNET_EVENT_RECORD_SELECTORS[name](event);
    if (record !== undefined) records.push(record);
  }
  return records;
}
