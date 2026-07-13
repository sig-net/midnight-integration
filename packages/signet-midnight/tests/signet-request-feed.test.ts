// Observer + feed tests over stub sources: a stub SignetEventSource serves
// constructed Misc events, and a stub state source serves the caller ledgers
// the resolver reads. No network, no compiled contract. Covers discovery order,
// resume floor, name filtering, membership-gated yielding, forged-event drops,
// dedupe, and the optional policy allow-list.

import { describe, expect, it, vi } from "vitest";

import {
  CompactTypeUnsignedInteger,
  StateMap,
  StateValue,
  type StateValue as StateValueType,
} from "@midnight-ntwrk/compact-runtime";
import type {
  ContractEvent,
  ContractEventQueryFilter,
} from "@midnight-ntwrk/midnight-js-types";

import {
  SignetEventObserver,
  SignetRequestFeed,
  TxParamType,
  asciiPadded,
  bytesToHex,
  evmAddressAbiWord,
  numericAbiWordValue,
  requestIdHex,
  requestIdType,
  signBidirectionalEventCodec,
  signBidirectionalRequestDescriptor,
  type SignBidirectionalRequest,
  type SignetEventSource,
} from "../src/index.ts";

// The ERC20 transfer(address,uint256) selector — a realistic calldata fixture
// (the app-level constant lives in the cli, not the SDK).
const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

const u64 = new CompactTypeUnsignedInteger(18446744073709551615n, 8);
const REQUEST_DESCRIPTOR = signBidirectionalRequestDescriptor(2, 0, 0);

const SIGNET_ADDRESS = "signet-contract-address";

// Two requester contracts, each with one request in its field-0 index.
const CALLER_A_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const CALLER_A = bytesToHex(CALLER_A_BYTES);
const CALLER_B_BYTES = bytes(32, 0x7c);
const CALLER_B = bytesToHex(CALLER_B_BYTES);

const REQUEST_A_ID = bytes(32, 0x2f);
const REQUEST_B_ID = bytes(32, 0x31);
const FORGED_CALLER_BYTES = bytes(32, 0xff); // no state at this address

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

/** Caller state with `requestId` in the field-0 request index. */
const callerStateWith = (requestId: Uint8Array): StateValueType => {
  const map = new StateMap().insert(
    { value: requestIdType.toValue(requestId), alignment: requestIdType.alignment() },
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

const STATE_TABLE: Record<string, StateValueType> = {
  [CALLER_A]: callerStateWith(REQUEST_A_ID),
  [CALLER_B]: callerStateWith(REQUEST_B_ID),
};

/**
 * A `serialize<SignBidirectionalEvent,256>` payload. The frozen envelope tags
 * `version` at byte 0, shifting the V1 fields: caller[1..33], requestId[33..65],
 * requestsIndexField[65].
 */
const payloadFor = (caller: Uint8Array, requestId: Uint8Array): Uint8Array => {
  const payload = new Uint8Array(256);
  payload[0] = 1; // version
  payload.set(caller, 1);
  payload.set(requestId, 33);
  payload[65] = 0; // requestsIndexField
  return payload;
};

/** Build a Misc ContractEvent with a given tag, payload, and cursor id. */
const miscEvent = (
  id: number,
  tag: string,
  payload: Uint8Array,
): ContractEvent =>
  ({
    eventType: "Misc",
    name: bytesToHex(asciiPadded(tag, 32)),
    payload: bytesToHex(payload),
    id,
    maxId: 100,
    version: 1,
    contractAddress: SIGNET_ADDRESS,
    transactionId: id,
    raw: "",
  }) as ContractEvent;

const signEvent = (
  id: number,
  caller: Uint8Array,
  requestId: Uint8Array,
): ContractEvent => miscEvent(id, "SignBidirectionalEvent", payloadFor(caller, requestId));

/** Stub event source over a fixed event list; records how it was filtered. */
const stubEventSource = (
  events: ContractEvent[],
): SignetEventSource & { queryContractEvents: ReturnType<typeof vi.fn> } => {
  const queryContractEvents = vi.fn(
    async (_filter: ContractEventQueryFilter) => events,
  );
  return { queryContractEvents } as never;
};

/** Combined event + state source for the feed. */
const stubFeedSource = (
  events: ContractEvent[],
  table: Record<string, StateValueType> = STATE_TABLE,
) => ({
  queryContractEvents: vi.fn(async () => events),
  queryContractState: vi.fn(async (address: string) => {
    const data = table[address];
    return data ? { data } : null;
  }),
});

async function collect<T>(
  iterable: AsyncIterable<T>,
  count: number,
): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
    if (out.length >= count) break;
  }
  return out;
}

describe("SignetEventObserver", () => {
  it("decodes SignBidirectionalEvent notifications in ascending id order", async () => {
    const source = stubEventSource([
      signEvent(5, CALLER_B_BYTES, REQUEST_B_ID),
      signEvent(2, CALLER_A_BYTES, REQUEST_A_ID),
    ]);
    const observer = new SignetEventObserver({
      signetContractAddress: SIGNET_ADDRESS,
      source,
      codec: signBidirectionalEventCodec,
    });
    const events = await observer.currentEvents();
    expect(events.map((e) => e.callerAddress)).toEqual([CALLER_A, CALLER_B]);
  });

  it("filters out Misc events with a non-matching name tag", async () => {
    const source = stubEventSource([
      miscEvent(1, "deposit", payloadFor(CALLER_A_BYTES, REQUEST_A_ID)),
      signEvent(2, CALLER_A_BYTES, REQUEST_A_ID),
    ]);
    const observer = new SignetEventObserver({
      signetContractAddress: SIGNET_ADDRESS,
      source,
      codec: signBidirectionalEventCodec,
    });
    const events = await observer.currentEvents();
    expect(events).toHaveLength(1);
    expect(events[0].requestId).toBe(requestIdHex(REQUEST_A_ID));
  });

  it("queries with the Misc filter for the signet contract", async () => {
    const source = stubEventSource([]);
    const observer = new SignetEventObserver({
      signetContractAddress: SIGNET_ADDRESS,
      source,
      codec: signBidirectionalEventCodec,
    });
    await observer.currentEvents();
    expect(source.queryContractEvents).toHaveBeenCalledWith({
      contractAddress: SIGNET_ADDRESS,
      types: ["Misc"],
    });
  });

  it("watch() yields each event once, in id order", async () => {
    const source = stubEventSource([
      signEvent(2, CALLER_A_BYTES, REQUEST_A_ID),
      signEvent(5, CALLER_B_BYTES, REQUEST_B_ID),
    ]);
    const observer = new SignetEventObserver({
      signetContractAddress: SIGNET_ADDRESS,
      source,
      codec: signBidirectionalEventCodec,
      pollIntervalMs: 1,
    });
    const seen = await collect(observer.watch(), 2);
    expect(seen.map((e) => e.callerAddress)).toEqual([CALLER_A, CALLER_B]);
  });

  it("watch() honours the resume floor (nothing at/below fromEventId)", async () => {
    const source = stubEventSource([
      signEvent(2, CALLER_A_BYTES, REQUEST_A_ID),
      signEvent(5, CALLER_B_BYTES, REQUEST_B_ID),
    ]);
    const observer = new SignetEventObserver({
      signetContractAddress: SIGNET_ADDRESS,
      source,
      codec: signBidirectionalEventCodec,
      fromEventId: 3,
      pollIntervalMs: 1,
    });
    const seen = await collect(observer.watch(), 1);
    expect(seen).toHaveLength(1);
    expect(seen[0].callerAddress).toBe(CALLER_B);
  });
});

describe("SignetRequestFeed", () => {
  it("yields only events that resolve to a member request", async () => {
    const source = stubFeedSource([
      signEvent(1, CALLER_A_BYTES, REQUEST_A_ID),
      signEvent(2, CALLER_B_BYTES, REQUEST_B_ID),
    ]);
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      source,
    });
    const resolved = await feed.poll();
    expect(resolved.map((r) => r.callerAddress)).toEqual([CALLER_A, CALLER_B]);
    expect(resolved.map((r) => r.requestId)).toEqual([
      requestIdHex(REQUEST_A_ID),
      requestIdHex(REQUEST_B_ID),
    ]);
  });

  it("drops a forged event whose caller holds no such request", async () => {
    const source = stubFeedSource([
      signEvent(1, FORGED_CALLER_BYTES, REQUEST_A_ID),
      signEvent(2, CALLER_A_BYTES, REQUEST_A_ID),
    ]);
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      source,
    });
    const resolved = await feed.poll();
    expect(resolved).toHaveLength(1);
    expect(resolved[0].callerAddress).toBe(CALLER_A);
  });

  it("dedupes a repeated requestId across polls", async () => {
    const source = stubFeedSource([signEvent(1, CALLER_A_BYTES, REQUEST_A_ID)]);
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      source,
    });
    expect(await feed.poll()).toHaveLength(1);
    expect(await feed.poll()).toHaveLength(0); // already yielded
  });

  it("re-yields a forgotten requestId (downstream-failure retry)", async () => {
    const source = stubFeedSource([signEvent(1, CALLER_A_BYTES, REQUEST_A_ID)]);
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      source,
    });
    expect(await feed.poll()).toHaveLength(1);
    feed.forget(requestIdHex(REQUEST_A_ID));
    expect(await feed.poll()).toHaveLength(1);
  });

  it("applies the allow-list when set (0x/case-insensitive)", async () => {
    const source = stubFeedSource([
      signEvent(1, CALLER_A_BYTES, REQUEST_A_ID),
      signEvent(2, CALLER_B_BYTES, REQUEST_B_ID),
    ]);
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      source,
      allowContracts: [`0x${CALLER_B.toUpperCase()}`],
    });
    const resolved = await feed.poll();
    expect(resolved.map((r) => r.callerAddress)).toEqual([CALLER_B]);
  });

  it("passes all callers when the allow-list is unset", async () => {
    const source = stubFeedSource([
      signEvent(1, CALLER_A_BYTES, REQUEST_A_ID),
      signEvent(2, CALLER_B_BYTES, REQUEST_B_ID),
    ]);
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      source,
    });
    expect(await feed.poll()).toHaveLength(2);
  });

  it("requests() streams resolved requests then can be stopped", async () => {
    const source = stubFeedSource([
      signEvent(1, CALLER_A_BYTES, REQUEST_A_ID),
      signEvent(2, CALLER_B_BYTES, REQUEST_B_ID),
    ]);
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      source,
      pollIntervalMs: 1,
    });
    const resolved = await collect(feed.requests(), 2);
    expect(resolved.map((r) => r.callerAddress)).toEqual([CALLER_A, CALLER_B]);
  });
});
