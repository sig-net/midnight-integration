// SignetRequestResponseReader over synthetic contract states: the requester
// and responses ledgers are encoded with the canonical descriptors into
// StateValue trees (the shape the indexer returns), served through a stub
// state source — no network, no compiled contract.

import { describe, expect, it } from "vitest";

import {
  CompactTypeUnsignedInteger,
  StateMap,
  StateValue,
} from "@midnight-ntwrk/compact-runtime";

import { computeAddress, SigningKey } from "ethers";

import {
  MPCDestination,
  MPCSignatureAlgorithm,
  TxParamType,
  asciiPadded,
  bigintToBytes32,
  evmAddressAbiWord,
  numericAbiWord,
  signatureToSignatureRespondedEvent,
  signBidirectionalEventToSignedEVMTransaction,
  signBidirectionalEventToUnsignedEVMTransaction,
  requestIdHex,
  requestIdType,
  signBidirectionalEventDescriptor,
  signatureRespondedEventType,
  respondBidirectionalEventType,
  signetMapKeyType,
  SignetRequestResponseReader,
  type SignBidirectionalEvent,
  type SignatureRespondedEvent,
  type SignetPublicStateSource,
  type RespondBidirectionalEvent,
} from "../src/index.ts";

// The ERC20 transfer(address,uint256) selector — a realistic calldata fixture
// (the app-level constant lives in the cli, not the SDK).
const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

// ---- Fixtures ----

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

const u64 = new CompactTypeUnsignedInteger(18446744073709551615n, 8);

/** The sample request's capacities (the vault's EVMType2TxParams<2, 0, 0>). */
const REQUEST_DESCRIPTOR = signBidirectionalEventDescriptor(2, 0, 0, 34, 34);

const REQUEST_ID = bytes(32, 0x2f);
const REQUEST_ID_HEX = requestIdHex(REQUEST_ID);
const UNKNOWN_ID_HEX = requestIdHex(bytes(32, 0x30));

const REQUESTER_ADDRESS = "requester-contract-address";
const SIGNET_CONTRACT_ADDRESS = "signet-contract-address";

/**
 * Known-good request record for a `transfer(vault, amount)` deposit — the
 * base every test uses. Shared across tests: NEVER mutate.
 */
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

// The "MPC" of these tests: a plain secp256k1 key standing in for the user's
// derived signer, plus a second key playing the imposter.
const MPC_KEY = new SigningKey(`0x${"11".repeat(32)}`);
const MPC_ADDRESS = computeAddress(MPC_KEY.publicKey);
const IMPOSTER_KEY = new SigningKey(`0x${"22".repeat(32)}`);
const IMPOSTER_ADDRESS = computeAddress(IMPOSTER_KEY.publicKey);

/** Sign `REQUEST`'s rebuilt tx hash with `key`, packed as a response record. */
const signResponse = (key: SigningKey): SignatureRespondedEvent =>
  signatureToSignatureRespondedEvent(
    key.sign(
      signBidirectionalEventToUnsignedEVMTransaction(REQUEST).unsignedHash,
    ),
  );

const GENUINE_RESPONSE = signResponse(MPC_KEY);
const IMPOSTER_RESPONSE = signResponse(IMPOSTER_KEY);
// An all-zero r cannot decode into a signature at all.
const UNDECODABLE_RESPONSE: SignatureRespondedEvent = {
  bigRx: bytes(32, 0),
  bigRy: bytes(32, 0),
  s: bytes(32, 0),
  recoveryId: 0n,
};

// ---- Synthetic ledger states (signet layout convention) ----

/** Requester state: request index (field 0) holding REQUEST, nonce (field 1). */
const requesterState = (): StateValue => {
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

// A respond-bidirectional record for the response tests: synthetic LE
// signature scalars — the reader decodes, verification is the CLIENT's job.
const RESPOND_BIDIRECTIONAL: RespondBidirectionalEvent = {
  serializedOutput: (() => { const out = new Uint8Array(128); out[0] = 1; return out; })(),
  outputLen: 32n,
  r: bigintToBytes32(123456789n),
  s: bigintToBytes32(987654321n),
  recoveryId: 1n,
};

/** A one-entry `Map<RequestId, Counter>` for REQUEST_ID, empty at 0. */
const counterMapOf = (total: bigint): StateMap => {
  let map = new StateMap();
  if (total > 0n) {
    map = map.insert(
      {
        value: requestIdType.toValue(REQUEST_ID),
        alignment: requestIdType.alignment(),
      },
      StateValue.newCell({
        value: u64.toValue(total),
        alignment: u64.alignment(),
      }),
    );
  }
  return map;
};

/**
 * Signet contract state in the 6-field layout: notification counter/map
 * (fields 0/1, empty), signature counter/map (fields 2/3), respond-
 * bidirectional counter/map (fields 4/5) for REQUEST_ID. `counterOverride`
 * forces a counter that disagrees with the log, for the inconsistency test.
 */
const signetContractState = (
  posts: SignatureRespondedEvent[],
  counterOverride?: bigint,
  respondBidirectional?: RespondBidirectionalEvent,
): StateValue => {
  const total = counterOverride ?? BigInt(posts.length);
  let responseMap = new StateMap();
  posts.forEach((post, index) => {
    responseMap = responseMap.insert(
      {
        value: signetMapKeyType.toValue({
          count: BigInt(index),
          requestId: REQUEST_ID,
        }),
        alignment: signetMapKeyType.alignment(),
      },
      StateValue.newCell({
        value: signatureRespondedEventType.toValue(post),
        alignment: signatureRespondedEventType.alignment(),
      }),
    );
  });
  let respondBidirectionalMap = new StateMap();
  if (respondBidirectional !== undefined) {
    respondBidirectionalMap = respondBidirectionalMap.insert(
      {
        value: signetMapKeyType.toValue({ count: 0n, requestId: REQUEST_ID }),
        alignment: signetMapKeyType.alignment(),
      },
      StateValue.newCell({
        value: respondBidirectionalEventType.toValue(respondBidirectional),
        alignment: respondBidirectionalEventType.alignment(),
      }),
    );
  }
  return StateValue.newArray()
    .arrayPush(StateValue.newMap(new StateMap())) // field 0: notification counter map
    .arrayPush(StateValue.newMap(new StateMap())) // field 1: notification map
    .arrayPush(StateValue.newMap(counterMapOf(total))) // field 2: signature counter map
    .arrayPush(StateValue.newMap(responseMap)) // field 3: signature map
    .arrayPush(
      StateValue.newMap(counterMapOf(respondBidirectional === undefined ? 0n : 1n)),
    ) // field 4: respond-bidirectional counter map
    .arrayPush(StateValue.newMap(respondBidirectionalMap)); // field 5: respond-bidirectional map
};

// ---- Harness ----

/**
 * Build a reader over synthetic states, counting state-source queries so the
 * request-record caching is observable.
 */
const makeReader = (
  posts: SignatureRespondedEvent[],
  counterOverride?: bigint,
  respondBidirectional?: RespondBidirectionalEvent,
) => {
  const queries = { requester: 0, responses: 0 };
  const publicDataProvider: SignetPublicStateSource = {
    queryContractState: async (contractAddress) => {
      if (contractAddress === REQUESTER_ADDRESS) {
        queries.requester += 1;
        return { data: requesterState() };
      }
      queries.responses += 1;
      return { data: signetContractState(posts, counterOverride, respondBidirectional) };
    },
  };
  const reader = new SignetRequestResponseReader({
    requesterContractAddress: REQUESTER_ADDRESS,
    requesterRequestsIndexField: 0,
    signetContractAddress: SIGNET_CONTRACT_ADDRESS,
    publicDataProvider,
  });
  return { reader, queries };
};

// ---- Tests ----

describe("getSignatureRequest", () => {
  it("returns the stored request record", async () => {
    const { reader } = makeReader([]);
    expect(await reader.getSignatureRequest(REQUEST_ID_HEX)).toEqual(REQUEST);
  });

  it("throws for a request id not on the ledger", async () => {
    const { reader } = makeReader([]);
    await expect(reader.getSignatureRequest(UNKNOWN_ID_HEX)).rejects.toThrow(
      /not on the requester contract's ledger/,
    );
  });

  it("caches the record: repeated fetches query the requester once", async () => {
    const { reader, queries } = makeReader([GENUINE_RESPONSE]);
    await reader.getSignatureRequest(REQUEST_ID_HEX);
    await reader.getSignatureRequest(REQUEST_ID_HEX);
    await reader.getVerifiedSignatureRespondedEvent(REQUEST_ID_HEX, MPC_ADDRESS);
    expect(queries.requester).toBe(1);
  });

  it("throws when the requester contract has no state", async () => {
    const publicDataProvider: SignetPublicStateSource = {
      queryContractState: async () => null,
    };
    const reader = new SignetRequestResponseReader({
      requesterContractAddress: REQUESTER_ADDRESS,
      requesterRequestsIndexField: 0,
      signetContractAddress: SIGNET_CONTRACT_ADDRESS,
      publicDataProvider,
    });
    await expect(reader.getSignatureRequest(REQUEST_ID_HEX)).rejects.toThrow(
      /is it deployed/,
    );
  });
});

describe("getSignatureResponses", () => {
  it("returns every post in count order", async () => {
    const { reader } = makeReader([UNDECODABLE_RESPONSE, GENUINE_RESPONSE]);
    expect(await reader.getSignatureResponses(REQUEST_ID_HEX)).toEqual([
      UNDECODABLE_RESPONSE,
      GENUINE_RESPONSE,
    ]);
  });

  it("returns an empty array when nothing is posted", async () => {
    const { reader } = makeReader([]);
    expect(await reader.getSignatureResponses(REQUEST_ID_HEX)).toEqual([]);
  });

  it("throws when the counter disagrees with the log", async () => {
    const { reader } = makeReader([GENUINE_RESPONSE], 2n);
    await expect(reader.getSignatureResponses(REQUEST_ID_HEX)).rejects.toThrow(
      /ledger state is inconsistent/,
    );
  });
});

/** One row of the verdict table: posted responses → expected result. */
interface VerdictCase {
  /** Test name, completing the sentence "resolves <name>". */
  name: string;
  /** The posts on the ledger, in count order. */
  posts: SignatureRespondedEvent[];
  /** The signer verification demands. */
  expectedSigner: string;
  /** Index (count) of the post expected as `verified`; absent = none valid. */
  verifiedPost?: number;
  /** Per-post rejection-reason pattern; `undefined` = the post is valid. */
  rejectedReasons: (RegExp | undefined)[];
}

const VERDICT_CASES: VerdictCase[] = [
  {
    name: "a single genuine post",
    posts: [GENUINE_RESPONSE],
    expectedSigner: MPC_ADDRESS,
    verifiedPost: 0,
    rejectedReasons: [undefined],
  },
  {
    name: "a genuine post behind noise — first VALID wins, noise gets reasons",
    posts: [UNDECODABLE_RESPONSE, IMPOSTER_RESPONSE, GENUINE_RESPONSE],
    expectedSigner: MPC_ADDRESS,
    verifiedPost: 2,
    rejectedReasons: [
      /not a decodable signature/,
      new RegExp(`signed by ${IMPOSTER_ADDRESS}, expected ${MPC_ADDRESS}`),
      undefined,
    ],
  },
  {
    name: "a genuine post with a lowercased expected signer",
    posts: [GENUINE_RESPONSE],
    expectedSigner: MPC_ADDRESS.toLowerCase(),
    verifiedPost: 0,
    rejectedReasons: [undefined],
  },
  {
    name: "only an imposter post — nothing verifies",
    posts: [IMPOSTER_RESPONSE],
    expectedSigner: MPC_ADDRESS,
    rejectedReasons: [/signed by 0x.*expected 0x/],
  },
  {
    name: "no posts at all",
    posts: [],
    expectedSigner: MPC_ADDRESS,
    rejectedReasons: [],
  },
];

describe("getVerifiedSignatureRespondedEvent", () => {
  it.each(VERDICT_CASES)(
    "resolves $name",
    async ({ posts, expectedSigner, verifiedPost, rejectedReasons }) => {
      const { reader } = makeReader(posts);
      const { verified, verdicts } = await reader.getVerifiedSignatureRespondedEvent(
        REQUEST_ID_HEX,
        expectedSigner,
      );

      expect(verified).toEqual(
        verifiedPost === undefined ? undefined : posts[verifiedPost],
      );

      expect(verdicts).toHaveLength(rejectedReasons.length);
      verdicts.forEach((verdict, index) => {
        expect(verdict.count).toBe(BigInt(index));
        expect(verdict.response).toEqual(posts[index]);
        const expectedReason = rejectedReasons[index];
        if (expectedReason === undefined) {
          expect(verdict.rejectedReason).toBeUndefined();
          expect(verdict.signer).toBe(MPC_ADDRESS);
        } else {
          expect(verdict.rejectedReason).toMatch(expectedReason);
        }
      });
    },
  );
});

describe("getUnsignedEVMTransaction", () => {
  it("rebuilds the request's unsigned transaction", async () => {
    const { reader, queries } = makeReader([]);
    const tx = await reader.getUnsignedEVMTransaction(REQUEST_ID_HEX);

    expect(tx.isSigned()).toBe(false);
    expect(tx.unsignedHash).toBe(
      signBidirectionalEventToUnsignedEVMTransaction(REQUEST).unsignedHash,
    );
    // Unsigned needs only the request record — never touches the signet contract.
    expect(queries.responses).toBe(0);
  });

  it("throws for a request id not on the ledger", async () => {
    const { reader } = makeReader([]);
    await expect(
      reader.getUnsignedEVMTransaction(UNKNOWN_ID_HEX),
    ).rejects.toThrow(/not on the requester contract's ledger/);
  });
});

describe("getSignedEVMTransaction", () => {
  it("attaches the first verified response, ready to broadcast", async () => {
    const { reader } = makeReader([IMPOSTER_RESPONSE, GENUINE_RESPONSE]);
    const tx = await reader.getSignedEVMTransaction(REQUEST_ID_HEX, MPC_ADDRESS);

    expect(tx?.isSigned()).toBe(true);
    expect(tx?.from).toBe(MPC_ADDRESS);
    // Identical to assembling it directly from the request and genuine post.
    expect(tx?.serialized).toBe(
      signBidirectionalEventToSignedEVMTransaction(REQUEST, GENUINE_RESPONSE)
        .serialized,
    );
  });

  it("returns undefined when no posted response verifies", async () => {
    const { reader } = makeReader([IMPOSTER_RESPONSE, UNDECODABLE_RESPONSE]);
    expect(
      await reader.getSignedEVMTransaction(REQUEST_ID_HEX, MPC_ADDRESS),
    ).toBeUndefined();
  });

  it("returns undefined when nothing is posted yet", async () => {
    const { reader } = makeReader([]);
    expect(
      await reader.getSignedEVMTransaction(REQUEST_ID_HEX, MPC_ADDRESS),
    ).toBeUndefined();
  });
});

describe("getRespondBidirectionalEvents", () => {
  it("returns the posted responses in count order", async () => {
    const { reader } = makeReader([], undefined, RESPOND_BIDIRECTIONAL);
    expect(await reader.getRespondBidirectionalEvents(REQUEST_ID_HEX)).toEqual([
      RESPOND_BIDIRECTIONAL,
    ]);
  });

  it("returns an empty array when nothing is posted yet", async () => {
    const { reader } = makeReader([]);
    expect(
      await reader.getRespondBidirectionalEvents(REQUEST_ID_HEX),
    ).toEqual([]);
  });
});
