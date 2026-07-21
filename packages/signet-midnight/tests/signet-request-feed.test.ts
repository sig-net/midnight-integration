// Feed tests over a stub state source: the stub serves BOTH the signet
// contract's raw state (whose field-4 notification registry the feed polls,
// with records packed by the REAL compiled circuit — lockstep by construction)
// and the caller ledgers the resolver reads. No network, no docker. Covers
// discovery, membership-gated yielding, forged-notification drops, dedupe,
// forget, unsupported-version skips, stable ordering, and the optional policy
// allow-list.

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
  numericAbiWordValue,
  pureCircuits,
  requestIdHex,
  requestIdType,
  signBidirectionalNotificationType,
  signBidirectionalEventDescriptor,
  signetMapKeyType,
  type SignBidirectionalNotificationRecord,
  type SignBidirectionalEvent,
} from "../src/index.ts";

// The ERC20 transfer(address,uint256) selector — a realistic calldata fixture
// (the app-level constant lives in the cli, not the SDK).
const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

const u64 = new CompactTypeUnsignedInteger(18446744073709551615n, 8);
const REQUEST_DESCRIPTOR = signBidirectionalEventDescriptor(2, 0, 0, 34, 34);

const SIGNET_ADDRESS = "signet-contract-address";

// Two requester contracts, each with one request in its field-0 index.
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
        words: [evmAddressAbiWord(bytes(20, 0xee)), numericAbiWordValue(1_000_000n)],
      },
    },
  },
  caip2Id: asciiPadded("eip155:11155111", 32),
  // Schema fixtures end in a non-zero byte (the exact-length convention).
  outputDeserializationSchema: bytes(34, 0x07),
  respondSerializationSchema: bytes(34, 0x08),
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

/**
 * A V1 notification record, packed by the REAL compiled circuit — the same
 * packer client contracts call in-circuit, so these fixtures pin the
 * pack↔decode lockstep by construction. The request id is NOT in the
 * payload: it lives in the registry map key.
 */
const notification = (
  caller: Uint8Array,
  _requestId?: Uint8Array,
): SignBidirectionalNotificationRecord =>
  pureCircuits.constructSignBidirectionalEventNotificationV1(
    { bytes: caller },
    0n,
  );

/**
 * Synthetic SIGNET contract state: the 6-field layout with the notification
 * map (field 1) holding the given records under SignetMapKey(0, requestId).
 * The other fields are present (empty maps) so field positions stay honest.
 */
const signetStateWith = (
  entries: Array<{ key: Uint8Array; record: SignBidirectionalNotificationRecord }>,
): StateValueType => {
  let registry = new StateMap();
  for (const { key, record } of entries) {
    registry = registry.insert(
      {
        value: signetMapKeyType.toValue({ count: 0n, requestId: key }),
        alignment: signetMapKeyType.alignment(),
      },
      StateValue.newCell({
        value: signBidirectionalNotificationType.toValue(record),
        alignment: signBidirectionalNotificationType.alignment(),
      }),
    );
  }
  return StateValue.newArray()
    .arrayPush(StateValue.newMap(new StateMap())) // field 0: notification counter map
    .arrayPush(StateValue.newMap(registry)) // field 1: notification map
    .arrayPush(StateValue.newMap(new StateMap())) // field 2: signature response counter map
    .arrayPush(StateValue.newMap(new StateMap())) // field 3: signature response map
    .arrayPush(StateValue.newMap(new StateMap())) // field 4: respond-bidirectional counter map
    .arrayPush(StateValue.newMap(new StateMap())); // field 5: respond-bidirectional map
};

/**
 * Stub state source serving the signet contract's registry AND the caller
 * ledgers from one table, like a real indexer provider would.
 */
const stubStateSource = (
  entries: Array<{ key: Uint8Array; record: SignBidirectionalNotificationRecord }>,
  callers: Record<string, StateValueType> = {
    [CALLER_A]: callerStateWith(REQUEST_A_ID),
    [CALLER_B]: callerStateWith(REQUEST_B_ID),
  },
) => {
  const table: Record<string, StateValueType> = {
    ...callers,
    [SIGNET_ADDRESS]: signetStateWith(entries),
  };
  return {
    queryContractState: vi.fn(async (address: string) => {
      const data = table[address];
      return data ? { data } : null;
    }),
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
  it("yields only notifications that resolve to a member request", async () => {
    const source = stubStateSource([
      { key: REQUEST_A_ID, record: notification(CALLER_A_BYTES, REQUEST_A_ID) },
      { key: REQUEST_B_ID, record: notification(CALLER_B_BYTES, REQUEST_B_ID) },
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

  it("processes registry entries in ascending request-id-hex order", async () => {
    // Insert B before A; the feed's stable ordering must still yield A first
    // (0x2f… < 0x31…).
    const source = stubStateSource([
      { key: REQUEST_B_ID, record: notification(CALLER_B_BYTES, REQUEST_B_ID) },
      { key: REQUEST_A_ID, record: notification(CALLER_A_BYTES, REQUEST_A_ID) },
    ]);
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      source,
    });
    const resolved = await feed.poll();
    expect(resolved.map((r) => r.requestId)).toEqual([
      requestIdHex(REQUEST_A_ID),
      requestIdHex(REQUEST_B_ID),
    ]);
  });

  it("drops a forged notification whose caller holds no such request, WITHOUT marking it yielded", async () => {
    const forged = {
      key: REQUEST_B_ID,
      record: notification(FORGED_CALLER_BYTES, REQUEST_B_ID),
    };
    const source = stubStateSource([
      forged,
      { key: REQUEST_A_ID, record: notification(CALLER_A_BYTES, REQUEST_A_ID) },
    ]);
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      source,
    });
    const resolved = await feed.poll();
    expect(resolved).toHaveLength(1);
    expect(resolved[0].callerAddress).toBe(CALLER_A);
    // Not marked yielded: were CALLER_B's state to appear later under the same
    // request id, it would still be served (forget() not required).
    const retry = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      source: stubStateSource([
        { key: REQUEST_B_ID, record: notification(CALLER_B_BYTES, REQUEST_B_ID) },
      ]),
    });
    expect(await retry.poll()).toHaveLength(1);
  });

  it("skips an unsupported-version record without marking it yielded", async () => {
    const v1 = notification(CALLER_A_BYTES, REQUEST_A_ID);
    const source = stubStateSource([
      { key: REQUEST_A_ID, record: { ...v1, version: 2n } },
      { key: REQUEST_B_ID, record: notification(CALLER_B_BYTES, REQUEST_B_ID) },
    ]);
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      source,
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

  it("dedupes a repeated requestId across polls", async () => {
    const source = stubStateSource([
      { key: REQUEST_A_ID, record: notification(CALLER_A_BYTES, REQUEST_A_ID) },
    ]);
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      source,
    });
    expect(await feed.poll()).toHaveLength(1);
    expect(await feed.poll()).toHaveLength(0); // already yielded
  });

  it("re-yields a forgotten requestId (downstream-failure retry)", async () => {
    const source = stubStateSource([
      { key: REQUEST_A_ID, record: notification(CALLER_A_BYTES, REQUEST_A_ID) },
    ]);
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      source,
    });
    expect(await feed.poll()).toHaveLength(1);
    feed.forget(requestIdHex(REQUEST_A_ID));
    expect(await feed.poll()).toHaveLength(1);
  });

  it("applies the allow-list when set (0x/case-insensitive)", async () => {
    const source = stubStateSource([
      { key: REQUEST_A_ID, record: notification(CALLER_A_BYTES, REQUEST_A_ID) },
      { key: REQUEST_B_ID, record: notification(CALLER_B_BYTES, REQUEST_B_ID) },
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
    const source = stubStateSource([
      { key: REQUEST_A_ID, record: notification(CALLER_A_BYTES, REQUEST_A_ID) },
      { key: REQUEST_B_ID, record: notification(CALLER_B_BYTES, REQUEST_B_ID) },
    ]);
    const feed = new SignetRequestFeed({
      signetContractAddress: SIGNET_ADDRESS,
      source,
    });
    expect(await feed.poll()).toHaveLength(2);
  });

  it("throws when the signet contract has no readable state", async () => {
    const feed = new SignetRequestFeed({
      signetContractAddress: "unknown-address",
      source: stubStateSource([]),
    });
    await expect(feed.poll()).rejects.toThrow(/No contract state/);
  });

  it("requests() streams resolved requests then can be stopped", async () => {
    const source = stubStateSource([
      { key: REQUEST_A_ID, record: notification(CALLER_A_BYTES, REQUEST_A_ID) },
      { key: REQUEST_B_ID, record: notification(CALLER_B_BYTES, REQUEST_B_ID) },
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
