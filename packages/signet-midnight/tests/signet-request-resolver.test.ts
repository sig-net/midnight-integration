// Security test for the notification → authenticated request resolution. The
// notification is a pointer only: the resolver MUST read the request from the
// named caller's own ledger and MUST reject any id that is not a member of the
// index at the notification's field. A stub state source stands in for the
// indexer — no network, no compiled contract. See
// knowledge-base/caller-attribution.md.

import { describe, expect, it, vi } from "vitest";

import {
  CompactTypeUnsignedInteger,
  StateMap,
  StateValue,
  type StateValue as StateValueType,
} from "@midnight-ntwrk/compact-runtime";

import {
  SignetRequestResolver,
  TxParamType,
  asciiPadded,
  evmAddressAbiWord,
  numericAbiWordValue,
  requestIdHex,
  requestIdType,
  signBidirectionalRequestDescriptor,
  type SignBidirectionalNotification,
  type SignBidirectionalRequest,
  type SignetPublicStateSource,
} from "../src/index.ts";

// The ERC20 transfer(address,uint256) selector — a realistic calldata fixture
// (the app-level constant lives in the cli, not the SDK).
const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

const u64 = new CompactTypeUnsignedInteger(18446744073709551615n, 8);
const REQUEST_DESCRIPTOR = signBidirectionalRequestDescriptor(2, 0, 0);

const CALLER_ADDRESS = "caller-vault-address";
const REQUEST_ID = bytes(32, 0x2f);
const REQUEST_ID_HEX = requestIdHex(REQUEST_ID);
const NON_MEMBER_ID_HEX = requestIdHex(bytes(32, 0x30));

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

/** Caller state: request index (field 0) holding REQUEST, nonce (field 1). */
const callerState = (): StateValueType => {
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

/** Stub state source over a fixed address→state table; counts queries. */
const stubSource = (
  table: Record<string, StateValueType>,
): SignetPublicStateSource & { queryContractState: ReturnType<typeof vi.fn> } => {
  const queryContractState = vi.fn(async (address: string) => {
    const data = table[address];
    return data ? { data } : null;
  });
  return { queryContractState } as never;
};

const notificationFor = (
  overrides: Partial<SignBidirectionalNotification> = {},
): SignBidirectionalNotification => ({
  version: 1,
  callerAddress: CALLER_ADDRESS,
  requestId: REQUEST_ID_HEX,
  requestsIndexField: 0,
  ...overrides,
});

describe("SignetRequestResolver", () => {
  it("resolves a member request from the caller's authenticated ledger", async () => {
    const resolver = new SignetRequestResolver({
      source: stubSource({ [CALLER_ADDRESS]: callerState() }),
    });
    const resolved = await resolver.resolve(notificationFor());
    expect(resolved).toEqual({
      callerAddress: CALLER_ADDRESS,
      requestId: REQUEST_ID_HEX,
      request: REQUEST,
    });
  });

  it("drops (undefined, no throw) a notification whose requestId is not a member", async () => {
    const resolver = new SignetRequestResolver({
      source: stubSource({ [CALLER_ADDRESS]: callerState() }),
    });
    await expect(
      resolver.resolve(notificationFor({ requestId: NON_MEMBER_ID_HEX })),
    ).resolves.toBeUndefined();
  });

  it("drops a notification whose callerAddress holds no contract state", async () => {
    const resolver = new SignetRequestResolver({ source: stubSource({}) });
    await expect(resolver.resolve(notificationFor())).resolves.toBeUndefined();
  });

  it("drops a notification pointing at the wrong requestsIndexField", async () => {
    const resolver = new SignetRequestResolver({
      source: stubSource({ [CALLER_ADDRESS]: callerState() }),
    });
    // Field 1 is the nonce cell, not the request index.
    await expect(
      resolver.resolve(notificationFor({ requestsIndexField: 1 })),
    ).resolves.toBeUndefined();
  });

  it("does not throw when the source query itself rejects", async () => {
    const source = {
      queryContractState: vi.fn(async () => {
        throw new Error("indexer offline");
      }),
    } as unknown as SignetPublicStateSource;
    const resolver = new SignetRequestResolver({ source });
    await expect(resolver.resolve(notificationFor())).resolves.toBeUndefined();
  });

  it("caches a resolved request — re-resolving queries state once", async () => {
    const source = stubSource({ [CALLER_ADDRESS]: callerState() });
    const resolver = new SignetRequestResolver({ source });
    const first = await resolver.resolve(notificationFor());
    const second = await resolver.resolve(notificationFor());
    expect(second).toEqual(first);
    expect(source.queryContractState).toHaveBeenCalledTimes(1);
  });

  it("does not cache a drop — a later poll can still resolve it", async () => {
    // callerAddress has no state yet (request not indexed), then it appears.
    const table: Record<string, StateValueType> = {};
    const source = stubSource(table);
    const resolver = new SignetRequestResolver({ source });
    expect(await resolver.resolve(notificationFor())).toBeUndefined();
    table[CALLER_ADDRESS] = callerState();
    expect(await resolver.resolve(notificationFor())).toEqual({
      callerAddress: CALLER_ADDRESS,
      requestId: REQUEST_ID_HEX,
      request: REQUEST,
    });
  });
});
