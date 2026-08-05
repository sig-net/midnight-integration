// Feed tests over stub sources: the stub event source serves the signet
// contract's emitted notification events (records packed by the REAL
// compiled circuit, lockstep by construction) and the stub state source
// serves the caller ledgers the feed reads. No network, no docker.
// Covers discovery, the per-notified-request lookup, forged-notification
// drops, not-yet-indexed retries, dedupe, forget, unsupported-version
// skips, stable ordering, and the optional policy allow-list.

import { describe, expect, it, vi } from "vitest";

import {
  CompactTypeUnsignedInteger,
  StateMap,
  StateValue,
  type StateValue as StateValueType,
} from "@midnight-ntwrk/compact-runtime";

import {
  MPCDestination,
  MPCSignatureAlgorithm,
  SignetRequestFeed,
  TxParamType,
  asciiPadded,
  bytesToHex,
  evmAddressAbiWord,
  numericAbiWord,
  pureCircuits,
  requestIdHex,
  requestIdType,
  signBidirectionalEventDescriptor,
  type SignetMiscEvent,
  type SignBidirectionalEvent,
} from "../src/index.ts";

import { notificationEventOf } from "./signet-event-fixtures.ts";

// The ERC20 transfer(address,uint256) selector: a realistic calldata fixture
// (the app-level constant lives in the cli, not the SDK).
const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

const u64 = new CompactTypeUnsignedInteger(18446744073709551615n, 8);
const REQUEST_DESCRIPTOR = signBidirectionalEventDescriptor(2, 0, 0, 34, 34);

const SIGNET_ADDRESS = "signet-contract-address";

// Two requester contracts, each with requests in its field-0 index.
const CALLER_A_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const CALLER_A = bytesToHex(CALLER_A_BYTES);
const CALLER_B_BYTES = bytes(32, 0x7c);
const CALLER_B = bytesToHex(CALLER_B_BYTES);

const REQUEST_A_ID = bytes(32, 0x2f);
const REQUEST_B_ID = bytes(32, 0x31);
const FORGED_CALLER_BYTES = bytes(32, 0xff); // no state at this address

const REQUEST: SignBidirectionalEvent = {
  sender: { bytes: new Uint8Array(32) },
  requestNonce: 0n,
  keyVersion: 1n,
  path: new Uint8Array(32),
  algo: MPCSignatureAlgorithm.ecdsa,
  dest: MPCDestination.unused,
  params: new Uint8Array(64),
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
        words: [evmAddressAbiWord(bytes(20, 0xee)), numericAbiWord(1_000_000n)],
      },
    },
  },
  caip2Id: asciiPadded("eip155:11155111", 32),
  // Schema fixtures end in a non-zero byte (the exact-length convention).
  outputDeserializationSchema: bytes(34, 0x07),
  respondSerializationSchema: bytes(34, 0x08),
};

/** Caller state with the given ids in the field-0 request index. */
const callerStateWith = (...requestIds: Uint8Array[]): StateValueType => {
  let map = new StateMap();
  for (const requestId of requestIds) {
    map = map.insert(
      { value: requestIdType.toValue(requestId), alignment: requestIdType.alignment() },
      StateValue.newCell({
        value: REQUEST_DESCRIPTOR.toValue(REQUEST),
        alignment: REQUEST_DESCRIPTOR.alignment(),
      }),
    );
  }
  return StateValue.newArray()
    .arrayPush(StateValue.newMap(map))
    .arrayPush(
      StateValue.newCell({ value: u64.toValue(1n), alignment: u64.alignment() }),
    );
};

/**
 * A notification event declaring `requestId` in `caller`'s field-0 request
 * map, its record packed by the REAL compiled circuit (the same packer
 * client contracts call in-circuit), so these fixtures pin the pack↔decode
 * lockstep by construction. The feed looks the declared id up in the
 * pointed-at map.
 */
const notification = (
  caller: Uint8Array,
  requestId: Uint8Array,
): SignetMiscEvent =>
  notificationEventOf(
    requestId,
    pureCircuits.constructSignBidirectionalEventNotificationV1(
      { bytes: caller },
      1n,
      [0n, 0n, 0n, 0n],
    ),
  );

/**
 * Stub sources: the event source serves the signet contract's notification
 * events, the state source serves the caller ledgers, like a real indexer
 * provider pair would. `callers` is read at query time, so a test can
 * mutate it between polls to simulate a ledger write indexing late.
 */
const stubSources = (
  events: SignetMiscEvent[],
  callers: Record<string, StateValueType> = {
    [CALLER_A]: callerStateWith(REQUEST_A_ID),
    [CALLER_B]: callerStateWith(REQUEST_B_ID),
  },
) => {
  return {
    eventSource: {
      querySignetEvents: vi.fn(async (address: string) => {
        expect(address).toBe(SIGNET_ADDRESS);
        return events;
      }),
    },
    source: {
      queryContractState: vi.fn(async (address: string) => {
        const data = callers[address];
        return data ? { data } : null;
      }),
    },
  };
};

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

describe("SignetRequestFeed", () => {
  it("yields each notified request, read from the named caller's own ledger", async () => {
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      ...stubSources([
        notification(CALLER_A_BYTES, REQUEST_A_ID),
        notification(CALLER_B_BYTES, REQUEST_B_ID),
      ]),
    });
    const resolved = await feed.poll();
    expect(resolved.map((r) => r.callerAddress)).toEqual([CALLER_A, CALLER_B]);
    expect(resolved.map((r) => r.requestId)).toEqual([
      requestIdHex(REQUEST_A_ID),
      requestIdHex(REQUEST_B_ID),
    ]);
    expect(resolved.map((r) => r.request)).toEqual([REQUEST, REQUEST]);
  });

  it("does NOT yield a stored request that was never notified", async () => {
    // A's map holds two requests, only REQUEST_A_ID is notified: the
    // notification is the doorbell, so the un-notified member stays unseen.
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      ...stubSources([notification(CALLER_A_BYTES, REQUEST_A_ID)], {
        [CALLER_A]: callerStateWith(REQUEST_A_ID, REQUEST_B_ID),
      }),
    });
    const resolved = await feed.poll();
    expect(resolved.map((r) => r.requestId)).toEqual([
      requestIdHex(REQUEST_A_ID),
    ]);
  });

  it("processes callers in address order and one caller's notified requests in request-id order", async () => {
    // Notify B's request first, then A's two high-id-first: the stable
    // ordering must still yield A's requests first, ascending.
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      ...stubSources(
        [
          notification(CALLER_B_BYTES, bytes(32, 0x99)),
          notification(CALLER_A_BYTES, REQUEST_B_ID),
          notification(CALLER_A_BYTES, REQUEST_A_ID),
        ],
        {
          [CALLER_A]: callerStateWith(REQUEST_B_ID, REQUEST_A_ID),
          [CALLER_B]: callerStateWith(bytes(32, 0x99)),
        },
      ),
    });
    const resolved = await feed.poll();
    expect(
      resolved.map((r) => [r.callerAddress, r.requestId]),
    ).toEqual([
      [CALLER_A, requestIdHex(REQUEST_A_ID)],
      [CALLER_A, requestIdHex(REQUEST_B_ID)],
      [CALLER_B, requestIdHex(bytes(32, 0x99))],
    ]);
  });

  it("queries one caller's state at most once per poll cycle", async () => {
    const sources = stubSources(
      [
        notification(CALLER_A_BYTES, REQUEST_A_ID),
        notification(CALLER_A_BYTES, REQUEST_B_ID),
      ],
      { [CALLER_A]: callerStateWith(REQUEST_A_ID, REQUEST_B_ID) },
    );
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      ...sources,
    });
    expect(await feed.poll()).toHaveLength(2);
    expect(sources.source.queryContractState).toHaveBeenCalledTimes(1);
  });

  it("drops a notification whose caller holds no state, WITHOUT marking anything yielded", async () => {
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      ...stubSources([
        notification(FORGED_CALLER_BYTES, REQUEST_B_ID),
        notification(CALLER_A_BYTES, REQUEST_A_ID),
      ]),
    });
    const resolved = await feed.poll();
    expect(resolved).toHaveLength(1);
    expect(resolved[0].callerAddress).toBe(CALLER_A);
    // Nothing was marked for the stateless caller: were its state to appear
    // later, its request would still be served (forget() not required).
    const retry = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      ...stubSources([notification(CALLER_B_BYTES, REQUEST_B_ID)]),
    });
    expect(await retry.poll()).toHaveLength(1);
  });

  it("retries a notified id the map does not hold yet, WITHOUT marking it", async () => {
    // The notification indexed before the caller's ledger write: the first
    // poll finds the map without the id and yields nothing, the next poll
    // (write now indexed) serves it.
    const callers: Record<string, StateValueType> = {
      [CALLER_A]: callerStateWith(),
    };
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      ...stubSources([notification(CALLER_A_BYTES, REQUEST_A_ID)], callers),
    });
    expect(await feed.poll()).toHaveLength(0);
    callers[CALLER_A] = callerStateWith(REQUEST_A_ID);
    const resolved = await feed.poll();
    expect(resolved.map((r) => r.requestId)).toEqual([
      requestIdHex(REQUEST_A_ID),
    ]);
  });

  it("yields nothing for a notification pointing at a non-map field", async () => {
    const wrongPath = notificationEventOf(
      REQUEST_A_ID,
      pureCircuits.constructSignBidirectionalEventNotificationV1(
        { bytes: CALLER_A_BYTES },
        1n,
        [1n, 0n, 0n, 0n], // field 1 is the nonce cell, not a request map
      ),
    );
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      ...stubSources([wrongPath]),
    });
    expect(await feed.poll()).toHaveLength(0);
  });

  it("skips an unsupported-version event without dropping the others", async () => {
    const v1 = notification(CALLER_A_BYTES, REQUEST_A_ID);
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      ...stubSources([
        { ...v1, payload: Uint8Array.from([2, ...v1.payload.slice(1)]) },
        notification(CALLER_B_BYTES, REQUEST_B_ID),
      ]),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const resolved = await feed.poll();
      expect(resolved.map((r) => r.requestId)).toEqual([
        requestIdHex(REQUEST_B_ID),
      ]);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("ignores events under other signet names", async () => {
    const v1 = notification(CALLER_A_BYTES, REQUEST_A_ID);
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      ...stubSources([{ ...v1, name: "SignatureRespondedEvent" }]),
    });
    expect(await feed.poll()).toHaveLength(0);
  });

  it("dedupes a repeated request id across polls", async () => {
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      ...stubSources([notification(CALLER_A_BYTES, REQUEST_A_ID)]),
    });
    expect(await feed.poll()).toHaveLength(1);
    expect(await feed.poll()).toHaveLength(0); // already yielded
  });

  it("re-yields a forgotten requestId (downstream-failure retry)", async () => {
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      ...stubSources([notification(CALLER_A_BYTES, REQUEST_A_ID)]),
    });
    expect(await feed.poll()).toHaveLength(1);
    feed.forget(requestIdHex(REQUEST_A_ID));
    expect(await feed.poll()).toHaveLength(1);
  });

  it("serves the genuine pointer beside a forged one declaring the same id", async () => {
    // A forged notification re-points REQUEST_A_ID at a stateless caller.
    // Pointers dedupe by the full (caller, path, id) triple, so the forgery
    // cannot shadow the genuine notification, whichever indexed first.
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      ...stubSources([
        notification(FORGED_CALLER_BYTES, REQUEST_A_ID),
        notification(CALLER_A_BYTES, REQUEST_A_ID),
      ]),
    });
    const resolved = await feed.poll();
    expect(
      resolved.map((r) => [r.callerAddress, r.requestId]),
    ).toEqual([[CALLER_A, requestIdHex(REQUEST_A_ID)]]);
  });

  it("applies the allow-list when set (0x/case-insensitive)", async () => {
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      ...stubSources([
        notification(CALLER_A_BYTES, REQUEST_A_ID),
        notification(CALLER_B_BYTES, REQUEST_B_ID),
      ]),
      allowContracts: [`0x${CALLER_B.toUpperCase()}`],
    });
    const resolved = await feed.poll();
    expect(resolved.map((r) => r.callerAddress)).toEqual([CALLER_B]);
  });

  it("passes all callers when the allow-list is unset", async () => {
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      ...stubSources([
        notification(CALLER_A_BYTES, REQUEST_A_ID),
        notification(CALLER_B_BYTES, REQUEST_B_ID),
      ]),
    });
    expect(await feed.poll()).toHaveLength(2);
  });

  it("propagates an event source failure", async () => {
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      eventSource: {
        querySignetEvents: async () => {
          throw new Error("indexer unreachable");
        },
      },
      source: stubSources([]).source,
    });
    await expect(feed.poll()).rejects.toThrow(/indexer unreachable/);
  });

  it("requests() streams resolved requests then can be stopped", async () => {
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      ...stubSources([
        notification(CALLER_A_BYTES, REQUEST_A_ID),
        notification(CALLER_B_BYTES, REQUEST_B_ID),
      ]),
      pollIntervalMs: 1,
    });
    const resolved = await collect(feed.requests(), 2);
    expect(resolved.map((r) => r.callerAddress)).toEqual([CALLER_A, CALLER_B]);
  });
});
