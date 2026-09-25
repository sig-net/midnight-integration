import { describe, expect, it } from "vitest";

import {
  abiWordToBool,
  abiWordToUint128,
  asciiPadded,
  boolAbiWord,
  bytesToHex,
  calculateEvmType2TxParamsDigest,
  calculateRequestId,
  decodeSignBidirectionalNotification,
  evmAddressAbiWord,
  type EvmType2TxParams,
  EXECUTION_DEST_BYTES,
  HashDomain,
  hexToBytes,
  MPCDestination,
  MPCSignatureAlgorithm,
  numericAbiWord,
  OutputKind,
  pureCircuits,
  type SignBidirectionalEvent,
  TxParamType,
} from "../src/index.ts";

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

describe("constructSignBidirectionalEventNotificationV1 (compiled packer)", () => {
  const CALLER = { bytes: bytes(32, 0xc1) };

  it("packs the V1 layout: callerAddress (32) ++ depth (1) ++ path (4) ++ zero padding (91)", () => {
    // A flat contract's field 4: path [4] at depth 1.
    const notification = pureCircuits.constructSignBidirectionalEventNotificationV1(CALLER, 1n, [
      4n,
      0n,
      0n,
      0n,
    ]);
    expect(notification.version).toBe(1n);
    expect(notification.payload).toHaveLength(128);
    expect(notification.payload.slice(0, 32)).toEqual(CALLER.bytes);
    expect(notification.payload[32]).toBe(1); // depth
    expect(notification.payload.slice(33, 37)).toEqual(Uint8Array.from([4, 0, 0, 0]));
    expect(notification.payload.slice(37)).toEqual(new Uint8Array(91));
  });

  it("packs a chunked contract's depth-2 path and the decoder trims to depth", () => {
    // A contract past 15 fields whose map compactc stored at chunk [1, 14].
    const notification = pureCircuits.constructSignBidirectionalEventNotificationV1(CALLER, 2n, [
      1n,
      14n,
      0n,
      0n,
    ]);
    expect(notification.payload[32]).toBe(2); // depth
    expect(notification.payload.slice(33, 37)).toEqual(Uint8Array.from([1, 14, 0, 0]));
    expect(decodeSignBidirectionalNotification(notification).requestsPath).toEqual([1, 14]);
  });

  it("round-trips through the decoder (pack↔decode lockstep)", () => {
    const notification = pureCircuits.constructSignBidirectionalEventNotificationV1(CALLER, 1n, [
      7n,
      0n,
      0n,
      0n,
    ]);
    expect(decodeSignBidirectionalNotification(notification)).toEqual({
      version: 1,
      callerAddress: bytesToHex(CALLER.bytes),
      requestsPath: [7],
    });
  });
});

describe("ethereumCaip2Id (MPC routing key)", () => {
  it("is eip155:1 zero-padded to the executionDest width", () => {
    // Lockstep with Chain::Ethereum.caip2_chain_id() in sig-net/mpc
    // signet-primitives/src/chain.rs: the MPC rejects any other value.
    expect(pureCircuits.ethereumCaip2Id()).toEqual(asciiPadded("eip155:1", EXECUTION_DEST_BYTES));
  });
});

describe("ABI word circuits (circuit/TS lockstep, golden bytes)", () => {
  // Each row pins BOTH the compiled circuit and its TS twin to fixed
  // big-endian bytes, so a compiler change that altered the circuit's cast
  // could not pass by the twin merely agreeing with it. Values sit on the
  // byte, 64-bit and 128-bit boundaries where an endianness slip shows.
  const NUMERIC_WORD_VECTORS: { value: bigint; word: string }[] = [
    { value: 0n, word: "0000000000000000000000000000000000000000000000000000000000000000" },
    { value: 1n, word: "0000000000000000000000000000000000000000000000000000000000000001" },
    { value: 255n, word: "00000000000000000000000000000000000000000000000000000000000000ff" },
    { value: 256n, word: "0000000000000000000000000000000000000000000000000000000000000100" },
    { value: 1_000_000n, word: "00000000000000000000000000000000000000000000000000000000000f4240" },
    {
      value: (1n << 64n) - 1n,
      word: "000000000000000000000000000000000000000000000000ffffffffffffffff",
    },
    {
      value: 1n << 64n,
      word: "0000000000000000000000000000000000000000000000010000000000000000",
    },
    {
      value: (1n << 64n) + 1n,
      word: "0000000000000000000000000000000000000000000000010000000000000001",
    },
    {
      value: (1n << 128n) - 1n,
      word: "00000000000000000000000000000000ffffffffffffffffffffffffffffffff",
    },
  ];

  it.each(NUMERIC_WORD_VECTORS)(
    "numericAbiWord($value): circuit and TS twin both emit $word",
    ({ value, word }) => {
      expect(bytesToHex(pureCircuits.numericAbiWord(value))).toBe(word);
      expect(bytesToHex(numericAbiWord(value))).toBe(word);
    },
  );

  it.each(NUMERIC_WORD_VECTORS)(
    "abiWordToUint128($word) reads back $value, circuit and TS",
    ({ value, word }) => {
      expect(pureCircuits.abiWordToUint128(hexToBytes(word))).toBe(value);
      expect(abiWordToUint128(hexToBytes(word))).toBe(value);
    },
  );

  it("abiWordToUint128 rejects a word wider than Uint<128>", () => {
    const wide = hexToBytes("0000000000000000000000000000000100000000000000000000000000000000");
    expect(() => pureCircuits.abiWordToUint128(wide)).toThrow();
    expect(() => abiWordToUint128(wide)).toThrow("exceeds Uint<128>");
  });

  it("evmAddressAbiWord: 12 zero bytes, then the display-order address, circuit and TS", () => {
    const address = hexToBytes("a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3");
    const word = "000000000000000000000000a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3";
    expect(bytesToHex(pureCircuits.evmAddressAbiWord(address))).toBe(word);
    expect(bytesToHex(evmAddressAbiWord(address))).toBe(word);
  });

  const BOOL_WORD_VECTORS: { value: boolean; word: string }[] = [
    { value: false, word: "0000000000000000000000000000000000000000000000000000000000000000" },
    { value: true, word: "0000000000000000000000000000000000000000000000000000000000000001" },
  ];

  it.each(BOOL_WORD_VECTORS)(
    "boolAbiWord($value): circuit and TS twin both emit $word",
    ({ value, word }) => {
      expect(bytesToHex(pureCircuits.boolAbiWord(value))).toBe(word);
      expect(bytesToHex(boolAbiWord(value))).toBe(word);
    },
  );

  it.each(BOOL_WORD_VECTORS)(
    "abiWordToBool($word) reads back $value, circuit and TS",
    ({ value, word }) => {
      expect(pureCircuits.abiWordToBool(hexToBytes(word))).toBe(value);
      expect(abiWordToBool(hexToBytes(word))).toBe(value);
    },
  );

  it.each([
    {
      reason: "nonzero byte in the zero prefix",
      word: "0100000000000000000000000000000000000000000000000000000000000000",
    },
    {
      reason: "last byte outside 0/1",
      word: "0000000000000000000000000000000000000000000000000000000000000002",
    },
  ])("abiWordToBool rejects $reason, circuit and TS", ({ word }) => {
    expect(() => pureCircuits.abiWordToBool(hexToBytes(word))).toThrow();
    expect(() => abiWordToBool(hexToBytes(word))).toThrow("canonical Boolean");
  });
});
describe("calculateEvmType2TxParamsDigestV1 (circuit/TS lockstep)", () => {
  // The same transaction, declared at the caller contracts' <1, 0, 0> shape
  // and at <2, 1, 2> with unused capacity in every dimension.
  const SCALARS = {
    chainId: 31337n,
    nonce: 1n,
    maxPriorityFeePerGas: 1_000_000_000n,
    maxFeePerGas: 30_000_000_000n,
    gasLimit: 100_000n,
    to: bytes(20, 0xaa),
    value: 0n,
  };
  const WORD = bytes(32, 0x11);
  const AT_1_0_0: EvmType2TxParams = {
    ...SCALARS,
    calldata: { is_some: true, value: { selector: bytes(4, 0xab), noWords: 1n, words: [WORD] } },
    accessListEntryCount: 0n,
    accessList: [],
  };
  const ZERO_ENTRY = {
    address: bytes(20, 0),
    storageKeyCount: 0n,
    storageKeys: [bytes(32, 0), bytes(32, 0)],
  };
  const AT_2_1_2: EvmType2TxParams = {
    ...SCALARS,
    calldata: {
      is_some: true,
      value: { selector: bytes(4, 0xab), noWords: 1n, words: [WORD, bytes(32, 0)] },
    },
    accessListEntryCount: 0n,
    accessList: [ZERO_ENTRY],
  };
  /** AT_2_1_2 with garbage in every unused slot. */
  const AT_2_1_2_GARBAGE: EvmType2TxParams = {
    ...SCALARS,
    calldata: {
      is_some: true,
      value: { selector: bytes(4, 0xab), noWords: 1n, words: [WORD, bytes(32, 0x99)] },
    },
    accessListEntryCount: 0n,
    accessList: [
      {
        address: bytes(20, 0x99),
        storageKeyCount: 2n,
        storageKeys: [bytes(32, 0x99), bytes(32, 0x99)],
      },
    ],
  };

  it.each([
    {
      name: "<1, 0, 0>",
      oracle: (t: EvmType2TxParams) => pureCircuits.calculateEvmType2TxParamsDigestV1_1_0_0(t),
      txParams: AT_1_0_0,
    },
    {
      name: "<2, 1, 2>",
      oracle: (t: EvmType2TxParams) => pureCircuits.calculateEvmType2TxParamsDigestV1_2_1_2(t),
      txParams: AT_2_1_2,
    },
    {
      name: "<2, 1, 2> with garbage in unused slots",
      oracle: (t: EvmType2TxParams) => pureCircuits.calculateEvmType2TxParamsDigestV1_2_1_2(t),
      txParams: AT_2_1_2_GARBAGE,
    },
    {
      name: "<2, 1, 2> with every capacity used",
      oracle: (t: EvmType2TxParams) => pureCircuits.calculateEvmType2TxParamsDigestV1_2_1_2(t),
      txParams: {
        ...SCALARS,
        calldata: {
          is_some: true,
          value: { selector: bytes(4, 0xab), noWords: 2n, words: [WORD, bytes(32, 0x12)] },
        },
        accessListEntryCount: 1n,
        accessList: [
          {
            address: bytes(20, 0xcc),
            storageKeyCount: 2n,
            storageKeys: [bytes(32, 0x22), bytes(32, 0x23)],
          },
        ],
      },
    },
    {
      name: "<2, 1, 2> with calldata absent",
      oracle: (t: EvmType2TxParams) => pureCircuits.calculateEvmType2TxParamsDigestV1_2_1_2(t),
      txParams: {
        ...AT_2_1_2,
        calldata: {
          is_some: false,
          value: { selector: bytes(4, 0), noWords: 0n, words: [bytes(32, 0), bytes(32, 0)] },
        },
      },
    },
  ])("TS twin equals the compiled circuit at $name", ({ oracle, txParams }) => {
    expect(bytesToHex(calculateEvmType2TxParamsDigest(txParams))).toBe(
      bytesToHex(oracle(txParams)),
    );
  });

  it("is the same digest whatever the capacities and whatever sits in unused slots", () => {
    const at100 = bytesToHex(pureCircuits.calculateEvmType2TxParamsDigestV1_1_0_0(AT_1_0_0));
    expect(bytesToHex(pureCircuits.calculateEvmType2TxParamsDigestV1_2_1_2(AT_2_1_2))).toBe(at100);
    expect(bytesToHex(pureCircuits.calculateEvmType2TxParamsDigestV1_2_1_2(AT_2_1_2_GARBAGE))).toBe(
      at100,
    );
  });

  it("an unused entry's storageKeyCount is ignored even past its capacity, on both sides", () => {
    const unusedOverCapacity: EvmType2TxParams = {
      ...AT_2_1_2_GARBAGE,
      accessList: [
        {
          address: bytes(20, 0x99),
          storageKeyCount: 3n,
          storageKeys: [bytes(32, 0x99), bytes(32, 0x99)],
        },
      ],
    };
    const at100 = bytesToHex(pureCircuits.calculateEvmType2TxParamsDigestV1_1_0_0(AT_1_0_0));
    expect(
      bytesToHex(pureCircuits.calculateEvmType2TxParamsDigestV1_2_1_2(unusedOverCapacity)),
    ).toBe(at100);
    expect(bytesToHex(calculateEvmType2TxParamsDigest(unusedOverCapacity))).toBe(at100);
  });

  it("an absent calldata contributes only its absence: its value arm never enters", () => {
    const absentZero: EvmType2TxParams = {
      ...AT_2_1_2,
      calldata: {
        is_some: false,
        value: { selector: bytes(4, 0), noWords: 0n, words: [bytes(32, 0), bytes(32, 0)] },
      },
    };
    const absentGarbage: EvmType2TxParams = {
      ...AT_2_1_2,
      calldata: {
        is_some: false,
        value: { selector: bytes(4, 0xab), noWords: 2n, words: [WORD, bytes(32, 0x99)] },
      },
    };
    const zero = bytesToHex(pureCircuits.calculateEvmType2TxParamsDigestV1_2_1_2(absentZero));
    expect(bytesToHex(pureCircuits.calculateEvmType2TxParamsDigestV1_2_1_2(absentGarbage))).toBe(
      zero,
    );
    expect(bytesToHex(calculateEvmType2TxParamsDigest(absentGarbage))).toBe(zero);
  });

  it.each([
    {
      reason: "a second calldata word comes into use",
      change: (t: EvmType2TxParams): EvmType2TxParams => ({
        ...t,
        calldata: { is_some: true, value: { ...t.calldata.value, noWords: 2n } },
      }),
    },
    {
      reason: "the used word changes",
      change: (t: EvmType2TxParams): EvmType2TxParams => ({
        ...t,
        calldata: {
          is_some: true,
          value: { ...t.calldata.value, words: [bytes(32, 0x12), bytes(32, 0)] },
        },
      }),
    },
    {
      reason: "an access-list entry comes into use",
      change: (t: EvmType2TxParams): EvmType2TxParams => ({
        ...t,
        accessListEntryCount: 1n,
        accessList: [
          {
            address: bytes(20, 0xcc),
            storageKeyCount: 0n,
            storageKeys: [bytes(32, 0), bytes(32, 0)],
          },
        ],
      }),
    },
    {
      reason: "the nonce changes",
      change: (t: EvmType2TxParams): EvmType2TxParams => ({ ...t, nonce: 2n }),
    },
  ])("changes when $reason, circuit and TS", ({ change }) => {
    const base = bytesToHex(pureCircuits.calculateEvmType2TxParamsDigestV1_2_1_2(AT_2_1_2));
    const changed = change(AT_2_1_2);
    const circuit = bytesToHex(pureCircuits.calculateEvmType2TxParamsDigestV1_2_1_2(changed));
    expect(circuit).not.toBe(base);
    expect(bytesToHex(calculateEvmType2TxParamsDigest(changed))).toBe(circuit);
  });

  it.each([
    {
      reason: "noWords past the word capacity",
      txParams: {
        ...AT_2_1_2,
        calldata: { is_some: true, value: { ...AT_2_1_2.calldata.value, noWords: 3n } },
      },
      error: /calldata noWords exceeds capacity/,
    },
    {
      reason: "an entry count past the entry capacity",
      txParams: { ...AT_2_1_2, accessListEntryCount: 2n },
      error: /accessListEntryCount exceeds capacity/,
    },
    {
      reason: "a storage key count past the key capacity",
      txParams: {
        ...AT_2_1_2,
        accessListEntryCount: 1n,
        accessList: [
          {
            address: bytes(20, 0xcc),
            storageKeyCount: 3n,
            storageKeys: [bytes(32, 0), bytes(32, 0)],
          },
        ],
      },
      error: /a used entry's storageKeyCount exceeds capacity/,
    },
  ])("rejects $reason, circuit and TS", ({ txParams, error }) => {
    expect(() => pureCircuits.calculateEvmType2TxParamsDigestV1_2_1_2(txParams)).toThrow();
    expect(() => calculateEvmType2TxParamsDigest(txParams)).toThrow(error);
  });
});

describe("calculateRequestIdV1 (circuit/TS lockstep)", () => {
  const RECORD: SignBidirectionalEvent = {
    keyVersion: 1n,
    sender: { bytes: bytes(32, 0x01) },
    path: bytes(32, 0x03),
    algo: MPCSignatureAlgorithm.ecdsa,
    txParamType: TxParamType.evmType2,
    txParams: {
      chainId: 31337n,
      nonce: 1n,
      maxPriorityFeePerGas: 1_000_000_000n,
      maxFeePerGas: 30_000_000_000n,
      gasLimit: 100_000n,
      to: bytes(20, 0xaa),
      value: 0n,
      calldata: {
        is_some: true,
        value: { selector: bytes(4, 0xab), noWords: 1n, words: [bytes(32, 0x11)] },
      },
      accessListEntryCount: 0n,
      accessList: [],
    },
    executionDest: bytes(32, 0x02),
    signatureDest: MPCDestination.unused,
    params: bytes(64, 0),
    outputDeserializationSchema: bytes(34, 0x07),
    respondSerializationSchema: bytes(34, 0x08),
  };

  it("constructs requests with unused reserved fields", () => {
    expect(pureCircuits.constructSignBidirectionalEventV1_1_0_0_34_34(RECORD)).toEqual(RECORD);
  });

  const INVALID_RESERVED_FIELDS: {
    name: string;
    request: SignBidirectionalEvent;
    error: string;
  }[] = [
    {
      name: "attestation key path",
      request: { ...RECORD, path: asciiPadded("midnight response key", 32) },
      error: "path is reserved for the MPC response key",
    },
    {
      name: "signature destination",
      request: { ...RECORD, signatureDest: MPCDestination.reserved },
      error: "signatureDest must be unused",
    },
    {
      name: "first parameter byte",
      request: { ...RECORD, params: Uint8Array.from([1, ...new Uint8Array(63)]) },
      error: "params must be zero",
    },
    {
      name: "last parameter byte",
      request: { ...RECORD, params: Uint8Array.from([...new Uint8Array(63), 1]) },
      error: "params must be zero",
    },
  ];

  it.each(INVALID_RESERVED_FIELDS)("refuses a reserved $name", ({ request, error }) => {
    expect(() => pureCircuits.constructSignBidirectionalEventV1_1_0_0_34_34(request)).toThrow(
      error,
    );
  });

  it("the TS request id equals the compiled circuit over the same preimage", () => {
    const circuit = pureCircuits.calculateRequestIdV1({
      keyVersion: RECORD.keyVersion,
      sender: RECORD.sender,
      path: RECORD.path,
      algo: RECORD.algo,
      txParamType: RECORD.txParamType,
      txParamsDigest: pureCircuits.calculateEvmType2TxParamsDigestV1_1_0_0(RECORD.txParams),
      executionDest: RECORD.executionDest,
    });
    expect(bytesToHex(calculateRequestId(RECORD))).toBe(bytesToHex(circuit));
  });

  /** RECORD at <2, 1, 2> with every capacity used. */
  const RECORD_2_1_2: SignBidirectionalEvent = {
    ...RECORD,
    txParams: {
      ...RECORD.txParams,
      calldata: {
        is_some: true,
        value: { selector: bytes(4, 0xab), noWords: 2n, words: [bytes(32, 0x11), bytes(32, 0x12)] },
      },
      accessListEntryCount: 1n,
      accessList: [
        {
          address: bytes(20, 0xcc),
          storageKeyCount: 2n,
          storageKeys: [bytes(32, 0x22), bytes(32, 0x23)],
        },
      ],
    },
  };

  it("pins all six domains through a transaction, request and attestation vector", () => {
    expect(bytesToHex(calculateEvmType2TxParamsDigest(RECORD_2_1_2.txParams))).toBe(
      "e5e11cd48153d16da6d9ec69b471848bafa6c1258a234b30359d383e3fba0b00",
    );
    const requestId: Uint8Array = calculateRequestId(RECORD_2_1_2);
    expect(bytesToHex(requestId)).toBe(
      "4c4e839b3257b4d73de4a362aabf435de1a4a137c0b220479d874c6b6b80fd00",
    );
    expect(
      bytesToHex(
        pureCircuits.calculateSignetAttestationDigest32(
          requestId,
          42n,
          OutputKind.executed,
          bytes(32, 0xab),
        ),
      ),
    ).toBe("41a1845ae55860bc1d9bf08d2581cbc5f2a34005e99ea51743db252040165400");
  });

  it.each([
    {
      name: "<1, 0, 0>",
      oracle: (r: SignBidirectionalEvent) =>
        pureCircuits.calculateEvmType2RequestIdV1_1_0_0_34_34(r),
      record: RECORD,
    },
    {
      name: "<2, 1, 2> with a used access list",
      oracle: (r: SignBidirectionalEvent) =>
        pureCircuits.calculateEvmType2RequestIdV1_2_1_2_34_34(r),
      record: RECORD_2_1_2,
    },
  ])(
    "the TS request id equals the compiled calculateEvmType2RequestIdV1 at $name",
    ({ oracle, record }) => {
      expect(bytesToHex(calculateRequestId(record))).toBe(bytesToHex(oracle(record)));
    },
  );

  it("gives the same request id to one transaction at different capacities", () => {
    const wider: SignBidirectionalEvent = {
      ...RECORD,
      txParams: {
        ...RECORD.txParams,
        calldata: {
          ...RECORD.txParams.calldata,
          value: {
            ...RECORD.txParams.calldata.value,
            words: [...RECORD.txParams.calldata.value.words, bytes(32, 0x99)],
          },
        },
        accessList: [
          {
            address: bytes(20, 0x99),
            storageKeyCount: 2n,
            storageKeys: [bytes(32, 0x99), bytes(32, 0x99)],
          },
        ],
      },
    };
    const requestId: Uint8Array = pureCircuits.calculateEvmType2RequestIdV1_1_0_0_34_34(RECORD);
    expect(pureCircuits.calculateEvmType2RequestIdV1_2_1_2_34_34(wider)).toEqual(requestId);
    expect(calculateRequestId(RECORD)).toEqual(requestId);
    expect(calculateRequestId(wider)).toEqual(requestId);
  });

  it("the circuit refuses a request whose tag is not evmType2", () => {
    expect(() =>
      pureCircuits.calculateEvmType2RequestIdV1_1_0_0_34_34({
        ...RECORD,
        txParamType: TxParamType.reserved,
      }),
    ).toThrow(/must tag txParams as evmType2/);
  });
});

describe("HashDomain protocol indices", () => {
  it.each([
    [HashDomain.requestId, 0],
    [HashDomain.attestationDigest, 1],
    [HashDomain.evmType2TxHeader, 2],
    [HashDomain.evmType2TxWord, 3],
    [HashDomain.evmType2TxAccessEntry, 4],
    [HashDomain.evmType2TxStorageKey, 5],
  ])("pins domain %i to protocol index %i", (domain: HashDomain, index: number) => {
    expect(domain).toBe(index);
  });
});
