// SignetResponseFeed tests over stub sources: a stub SignetEventSource serves
// constructed SignatureRespondedEvent Misc events, and a stub state source
// serves the requester ledger (holding the request) and the signet contract
// ledger (holding the posts). No network, no compiled contract. Covers the
// event-gated state read, verdict content, exactly-once yielding, event/state
// indexing skew in both directions, and the live stream.

import { describe, expect, it, vi } from "vitest";

import {
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  StateMap,
  StateValue,
  type StateValue as StateValueType,
} from "@midnight-ntwrk/compact-runtime";
import type { ContractEvent } from "@midnight-ntwrk/midnight-js-types";

import { computeAddress, SigningKey } from "ethers";

import {
  ERC20_TRANSFER_SELECTOR,
  SignetResponseFeed,
  TxParamType,
  asciiPadded,
  bytesToHex,
  evmAddressAbiWord,
  numericAbiWordValue,
  requestIdHex,
  requestIdType,
  signatureResponseType,
  signatureToSignatureResponse,
  signBidirectionalRequestDescriptor,
  signBidirectionalRequestToUnsignedEVMTransaction,
  signetResponseKeyType,
  type SignatureResponse,
  type SignBidirectionalRequest,
} from "../src/index.ts";

// ---- Fixtures ----

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

const u64 = new CompactTypeUnsignedInteger(18446744073709551615n, 8);
const bytes32 = new CompactTypeBytes(32);
const REQUEST_DESCRIPTOR = signBidirectionalRequestDescriptor(2, 0, 0);

const SIGNET_ADDRESS = "signet-contract-address";
const REQUESTER_ADDRESS = "requester-contract-address";

const REQUEST_ID = bytes(32, 0x2f);
const REQUEST_ID_HEX = requestIdHex(REQUEST_ID);
const OTHER_REQUEST_ID = bytes(32, 0x31);

const REQUEST: SignBidirectionalRequest = {
  requestNonce: 0n,
  txParamType: TxParamType.evmType2,
  txParams: {
    to: bytes(20, 0xaa),
    chainId: 11155111n,
    nonce: 7n,
    gasLimit: 100_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    value: 0n,
    accessListEntryCount: 0n,
    accessList: [],
    calldata: {
      is_some: true,
      value: {
        selector: ERC20_TRANSFER_SELECTOR,
        noWords: 2n,
        words: [evmAddressAbiWord(bytes(20, 0xee)), numericAbiWordValue(1_000_000n)],
      },
    },
  },
  caip2Id: asciiPadded("eip155:11155111", 32),
  keyVersion: 1n,
  path: new Uint8Array(256),
  algo: asciiPadded("ecdsa", 32),
  dest: asciiPadded("ethereum", 32),
  params: new Uint8Array(64),
  outputDeserializationSchema: new Uint8Array(128),
  respondSerializationSchema: new Uint8Array(128),
};

// The "MPC" of these tests (the user's derived signer) and an imposter.
const MPC_KEY = new SigningKey(`0x${"11".repeat(32)}`);
const MPC_ADDRESS = computeAddress(MPC_KEY.publicKey);
const IMPOSTER_KEY = new SigningKey(`0x${"22".repeat(32)}`);

/** Sign `REQUEST`'s rebuilt tx hash with `key`, packed as a response record. */
const signResponse = (key: SigningKey): SignatureResponse =>
  signatureToSignatureResponse(
    key.sign(
      signBidirectionalRequestToUnsignedEVMTransaction(REQUEST).unsignedHash,
    ),
  );

const GENUINE_RESPONSE = signResponse(MPC_KEY);
const IMPOSTER_RESPONSE = signResponse(IMPOSTER_KEY);

// ---- Synthetic states and events ----

/** Requester state: request index (field 0) holding REQUEST, nonce (field 1). */
const requesterState = (): StateValueType => {
  const map = new StateMap().insert(
    {
      value: requestIdType.toValue(REQUEST_ID),
      alignment: requestIdType.alignment(),
    },
    StateValue.newCell({
      value: REQUEST_DESCRIPTOR.toValue(REQUEST),
      alignment: REQUEST_DESCRIPTOR.alignment(),
    }),
  );
  return StateValue.newArray()
    .arrayPush(StateValue.newMap(map))
    .arrayPush(
      StateValue.newCell({ value: u64.toValue(1n), alignment: u64.alignment() }),
    );
};

/** Signet contract state holding `posts` for REQUEST_ID (layout fields 0-3). */
const signetState = (posts: SignatureResponse[]): StateValueType => {
  let counterMap = new StateMap();
  if (posts.length > 0) {
    counterMap = counterMap.insert(
      {
        value: requestIdType.toValue(REQUEST_ID),
        alignment: requestIdType.alignment(),
      },
      StateValue.newCell({
        value: u64.toValue(BigInt(posts.length)),
        alignment: u64.alignment(),
      }),
    );
  }
  let responseMap = new StateMap();
  posts.forEach((post, index) => {
    responseMap = responseMap.insert(
      {
        value: signetResponseKeyType.toValue({
          count: BigInt(index),
          requestId: REQUEST_ID,
        }),
        alignment: signetResponseKeyType.alignment(),
      },
      StateValue.newCell({
        value: signatureResponseType.toValue(post),
        alignment: signatureResponseType.alignment(),
      }),
    );
  });
  return StateValue.newArray()
    .arrayPush(StateValue.newMap(counterMap))
    .arrayPush(StateValue.newMap(responseMap))
    .arrayPush(StateValue.newMap(new StateMap()))
    .arrayPush(
      StateValue.newCell({
        value: bytes32.toValue(bytes(32, 0x99)),
        alignment: bytes32.alignment(),
      }),
    );
};

/** A `serialize<SignatureRespondedEvent,256>` payload (count little-endian). */
const respondedPayload = (requestId: Uint8Array, count: bigint): Uint8Array => {
  const payload = new Uint8Array(256);
  payload.set(requestId, 0);
  let value = count;
  for (let i = 0; i < 8; i++) {
    payload[32 + i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return payload;
};

/** Build a SignatureRespondedEvent Misc ContractEvent with cursor id. */
const respondedEvent = (
  id: number,
  requestId: Uint8Array,
  count: bigint,
): ContractEvent =>
  ({
    eventType: "Misc",
    name: bytesToHex(asciiPadded("SignatureRespondedEvent", 32)),
    payload: bytesToHex(respondedPayload(requestId, count)),
    id,
    maxId: 100,
    version: 1,
    contractAddress: SIGNET_ADDRESS,
    transactionId: id,
    raw: "",
  }) as ContractEvent;

/**
 * Combined event + state stub over MUTABLE `events` / `posts` arrays, so a
 * test can grow them mid-flight (indexing skew scenarios). Query counters
 * make the event-gated state read observable.
 */
const stubSource = (events: ContractEvent[], posts: SignatureResponse[]) => ({
  queryContractEvents: vi.fn(async () => [...events]),
  queryContractState: vi.fn(async (address: string) => {
    if (address === REQUESTER_ADDRESS) return { data: requesterState() };
    if (address === SIGNET_ADDRESS) return { data: signetState(posts) };
    return null;
  }),
});

const makeFeed = (source: ReturnType<typeof stubSource>) =>
  new SignetResponseFeed({
    signetContractAddress: SIGNET_ADDRESS,
    requesterContractAddress: REQUESTER_ADDRESS,
    source,
    pollIntervalMs: 1,
  });

/** Count only the signet-contract state queries (the response-log reads). */
const signetStateReads = (source: ReturnType<typeof stubSource>): number =>
  source.queryContractState.mock.calls.filter(
    ([address]) => address === SIGNET_ADDRESS,
  ).length;

// ---- Tests ----

describe("SignetResponseFeed.poll", () => {
  it("judges every announced post in count order — noise rejected, the genuine one valid", async () => {
    const source = stubSource(
      [
        respondedEvent(1, REQUEST_ID, 0n),
        respondedEvent(2, REQUEST_ID, 1n),
      ],
      [IMPOSTER_RESPONSE, GENUINE_RESPONSE],
    );
    const verdicts = await makeFeed(source).poll(REQUEST_ID_HEX, MPC_ADDRESS);

    expect(verdicts.map((v) => v.count)).toEqual([0n, 1n]);
    expect(verdicts[0].rejectedReason).toMatch(/signed by 0x.*expected 0x/);
    expect(verdicts[1].rejectedReason).toBeUndefined();
    expect(verdicts[1].response).toEqual(GENUINE_RESPONSE);
  });

  it("yields each post exactly once across polls", async () => {
    const source = stubSource(
      [respondedEvent(1, REQUEST_ID, 0n)],
      [GENUINE_RESPONSE],
    );
    const feed = makeFeed(source);
    expect(await feed.poll(REQUEST_ID_HEX, MPC_ADDRESS)).toHaveLength(1);
    expect(await feed.poll(REQUEST_ID_HEX, MPC_ADDRESS)).toHaveLength(0);
  });

  it("does not read the response log unless a new event names an unyielded post", async () => {
    const source = stubSource(
      [respondedEvent(1, REQUEST_ID, 0n)],
      [GENUINE_RESPONSE],
    );
    const feed = makeFeed(source);
    await feed.poll(REQUEST_ID_HEX, MPC_ADDRESS);
    const readsAfterFirst = signetStateReads(source);
    await feed.poll(REQUEST_ID_HEX, MPC_ADDRESS); // same event still visible
    expect(signetStateReads(source)).toBe(readsAfterFirst);
  });

  it("ignores events for other requests", async () => {
    const source = stubSource(
      [respondedEvent(1, OTHER_REQUEST_ID, 0n)],
      [GENUINE_RESPONSE],
    );
    const verdicts = await makeFeed(source).poll(REQUEST_ID_HEX, MPC_ADDRESS);
    expect(verdicts).toHaveLength(0);
    expect(signetStateReads(source)).toBe(0);
  });

  it("yields ledger posts beyond the announced ones (events trigger, ledger is truth)", async () => {
    // Only post 0's event is indexed, but the log already holds two posts.
    const source = stubSource(
      [respondedEvent(1, REQUEST_ID, 0n)],
      [IMPOSTER_RESPONSE, GENUINE_RESPONSE],
    );
    const verdicts = await makeFeed(source).poll(REQUEST_ID_HEX, MPC_ADDRESS);
    expect(verdicts.map((v) => v.count)).toEqual([0n, 1n]);
  });

  it("retries a post whose event is visible before its ledger write indexed", async () => {
    const events = [respondedEvent(1, REQUEST_ID, 0n)];
    const posts: SignatureResponse[] = []; // write not indexed yet
    const source = stubSource(events, posts);
    const feed = makeFeed(source);

    expect(await feed.poll(REQUEST_ID_HEX, MPC_ADDRESS)).toHaveLength(0);

    posts.push(GENUINE_RESPONSE); // the write lands
    const verdicts = await feed.poll(REQUEST_ID_HEX, MPC_ADDRESS);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].rejectedReason).toBeUndefined();
  });
});

describe("SignetResponseFeed.verdicts", () => {
  it("streams verdicts as posts appear, exactly once, until aborted", async () => {
    const events = [respondedEvent(1, REQUEST_ID, 0n)];
    const posts = [IMPOSTER_RESPONSE];
    const source = stubSource(events, posts);
    const feed = makeFeed(source);

    const seen: bigint[] = [];
    const controller = new AbortController();
    const consume = (async () => {
      for await (const verdict of feed.verdicts(REQUEST_ID_HEX, MPC_ADDRESS, {
        signal: controller.signal,
      })) {
        seen.push(verdict.count);
        if (verdict.rejectedReason === undefined) controller.abort();
      }
    })();

    // A second post (the genuine one) lands mid-stream.
    events.push(respondedEvent(2, REQUEST_ID, 1n));
    posts.push(GENUINE_RESPONSE);

    await consume;
    expect(seen).toEqual([0n, 1n]);
  });
});

describe("SignetResponseFeed.getSignatureRequest", () => {
  it("returns the stored request record for transaction assembly", async () => {
    const source = stubSource([], []);
    expect(await makeFeed(source).getSignatureRequest(REQUEST_ID_HEX)).toEqual(
      REQUEST,
    );
  });
});
