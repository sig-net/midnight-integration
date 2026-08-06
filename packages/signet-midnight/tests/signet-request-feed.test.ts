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
  calculateRequestId,
  evmAddressAbiWord,
  numericAbiWord,
  pureCircuits,
  requestIdBytes,
  requestIdHex,
  sleepUnlessAborted,
  type ResolvedSignetRequest,
  type SignetMiscEvent,
  type SignBidirectionalEvent,
} from "../src/index.ts";
// Package-internal descriptors, imported from their defining modules.
import { requestIdType } from "../src/signet-requests.ts";
import { signBidirectionalEventDescriptor } from "../src/signet-evtype2tx-requests.ts";

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
  outputDeserializationSchema: bytes(34, 0x07),
  respondSerializationSchema: bytes(34, 0x08),
};

// Distinct requests (nonce variations of REQUEST) under their computed ids:
// the feed's lookup recomputes a record's id and drops mismatches, so every
// fixture record must live under the id it hashes to.
const REQUEST_A = REQUEST;
const REQUEST_B: SignBidirectionalEvent = { ...REQUEST, requestNonce: 1n };
const REQUEST_C: SignBidirectionalEvent = { ...REQUEST, requestNonce: 2n };
const REQUEST_A_ID = calculateRequestId(REQUEST_A);
const REQUEST_B_ID = calculateRequestId(REQUEST_B);
const REQUEST_C_ID = calculateRequestId(REQUEST_C);

/** Caller state with the given records in the field-0 request index, each under its computed id. */
const callerStateWith = (...requests: SignBidirectionalEvent[]): StateValueType => {
  let map = new StateMap();
  for (const request of requests) {
    map = map.insert(
      {
        value: requestIdType.toValue(calculateRequestId(request)),
        alignment: requestIdType.alignment(),
      },
      StateValue.newCell({
        value: REQUEST_DESCRIPTOR.toValue(request),
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
    [CALLER_A]: callerStateWith(REQUEST_A),
    [CALLER_B]: callerStateWith(REQUEST_B),
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
    expect(resolved.map((r) => r.request)).toEqual([REQUEST_A, REQUEST_B]);
  });

  it("does NOT yield a stored request that was never notified", async () => {
    // A's map holds two requests, only REQUEST_A_ID is notified: the
    // notification is the doorbell, so the un-notified member stays unseen.
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      ...stubSources([notification(CALLER_A_BYTES, REQUEST_A_ID)], {
        [CALLER_A]: callerStateWith(REQUEST_A, REQUEST_B),
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
          notification(CALLER_B_BYTES, REQUEST_C_ID),
          notification(CALLER_A_BYTES, REQUEST_B_ID),
          notification(CALLER_A_BYTES, REQUEST_A_ID),
        ],
        {
          [CALLER_A]: callerStateWith(REQUEST_B, REQUEST_A),
          [CALLER_B]: callerStateWith(REQUEST_C),
        },
      ),
    });
    const resolved = await feed.poll();
    // Computed ids: derive A's ascending order rather than assuming it.
    const aIdsAscending = [
      requestIdHex(REQUEST_A_ID),
      requestIdHex(REQUEST_B_ID),
    ].sort();
    expect(
      resolved.map((r) => [r.callerAddress, r.requestId]),
    ).toEqual([
      [CALLER_A, aIdsAscending[0]],
      [CALLER_A, aIdsAscending[1]],
      [CALLER_B, requestIdHex(REQUEST_C_ID)],
    ]);
  });

  it("yields one caller's requests in ascending id order whatever the notification order", async () => {
    // Notify in DESCENDING id order so insertion order cannot masquerade as
    // the sort.
    const aIdsAscending = [
      requestIdHex(REQUEST_A_ID),
      requestIdHex(REQUEST_B_ID),
    ].sort();
    const descendingIdBytes = [...aIdsAscending]
      .reverse()
      .map((id) => requestIdBytes(id));
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      ...stubSources(
        descendingIdBytes.map((id) => notification(CALLER_A_BYTES, id)),
        { [CALLER_A]: callerStateWith(REQUEST_A, REQUEST_B) },
      ),
    });
    const resolved = await feed.poll();
    expect(resolved.map((r) => [r.callerAddress, r.requestId])).toEqual([
      [CALLER_A, aIdsAscending[0]],
      [CALLER_A, aIdsAscending[1]],
    ]);
  });

  it("queries one caller's state at most once per poll cycle", async () => {
    const sources = stubSources(
      [
        notification(CALLER_A_BYTES, REQUEST_A_ID),
        notification(CALLER_A_BYTES, REQUEST_B_ID),
      ],
      { [CALLER_A]: callerStateWith(REQUEST_A, REQUEST_B) },
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
    callers[CALLER_A] = callerStateWith(REQUEST_A);
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

describe("sleepUnlessAborted", () => {
  it("resolves immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const start = performance.now();
    await sleepUnlessAborted(1_000, controller.signal);
    expect(performance.now() - start).toBeLessThan(100);
  });

  it("resolves early when the signal aborts mid-sleep", async () => {
    const controller = new AbortController();
    const start = performance.now();
    const sleeping = sleepUnlessAborted(1_000, controller.signal);
    setTimeout(() => controller.abort(), 5);
    await sleeping;
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("resolves after the delay when nothing aborts", async () => {
    const start = performance.now();
    await sleepUnlessAborted(20);
    expect(performance.now() - start).toBeGreaterThanOrEqual(10);
  });
});

describe("SignetRequestFeed.requests: abort behaviour", () => {
  it("yields a discovered request and stops when the signal aborts", async () => {
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      ...stubSources([notification(CALLER_A_BYTES, REQUEST_A_ID)]),
      pollIntervalMs: 1,
    });
    const controller = new AbortController();
    const resolved: ResolvedSignetRequest[] = [];
    for await (const request of feed.requests({ signal: controller.signal })) {
      resolved.push(request);
      controller.abort();
    }
    expect(resolved.map((r) => r.requestId)).toEqual([
      requestIdHex(REQUEST_A_ID),
    ]);
  });

  it("completes immediately when the signal is already aborted", async () => {
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      ...stubSources([notification(CALLER_A_BYTES, REQUEST_A_ID)]),
      pollIntervalMs: 1,
    });
    const controller = new AbortController();
    controller.abort();
    const resolved: ResolvedSignetRequest[] = [];
    for await (const request of feed.requests({ signal: controller.signal })) {
      resolved.push(request);
    }
    expect(resolved).toEqual([]);
  });

  it("sleeps between polls when a cycle yields nothing", async () => {
    // The first poll sees no notifications, so the stream must sleep before
    // polling again and discovering the request.
    let calls = 0;
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      eventSource: {
        querySignetEvents: async () => {
          calls += 1;
          return calls === 1
            ? []
            : [notification(CALLER_A_BYTES, REQUEST_A_ID)];
        },
      },
      source: stubSources([]).source,
      pollIntervalMs: 1,
    });
    const resolved = await collect(feed.requests(), 1);
    expect(resolved.map((r) => r.requestId)).toEqual([
      requestIdHex(REQUEST_A_ID),
    ]);
  });
});

describe("SignetRequestFeed.poll: caller state-read failure", () => {
  it("yields nothing for a caller whose state read throws, and retries next cycle", async () => {
    const state = callerStateWith(REQUEST_A);
    let shouldThrow = true;
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      eventSource: {
        querySignetEvents: async () => [notification(CALLER_A_BYTES, REQUEST_A_ID)],
      },
      source: {
        queryContractState: async () => {
          if (shouldThrow) throw new Error("indexer unreachable");
          return { data: state };
        },
      },
    });
    // The read failure yields nothing AND marks nothing yielded: the retried
    // poll (read now succeeding) still serves the request.
    expect(await feed.poll()).toHaveLength(0);
    shouldThrow = false;
    expect(await feed.poll()).toHaveLength(1);
  });
});
