// SignetRequestResponseReader over synthetic contract states: the requester
// and responses ledgers are encoded with the canonical descriptors into
// StateValue trees (the shape the indexer returns), served through a stub
// state source — no network, no compiled contract.

import { describe, expect, it } from "vitest";

import {
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  StateMap,
  StateValue,
} from "@midnight-ntwrk/compact-runtime";

import { computeAddress, getBytes, SigningKey } from "ethers";

import {
  asciiPadded,
  bigintToBytes32,
  buildUnsignedEvmTransaction,
  requestIdHex,
  requestIdType,
  signatureResponseKeyType,
  signetEVMSignatureRequestType,
  SignetRequestResponseReader,
  type SignetEVMSignatureRequest,
  type SignetPublicStateSource,
} from "../src/index.ts";

// ---- Fixtures ----

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

const u64 = new CompactTypeUnsignedInteger(18446744073709551615n, 8);
const bytes65 = new CompactTypeBytes(65);

const REQUEST_ID = bytes(32, 0x2f);
const REQUEST_ID_HEX = requestIdHex(REQUEST_ID);
const UNKNOWN_ID_HEX = requestIdHex(bytes(32, 0x30));

const REQUESTER_ADDRESS = "requester-contract-address";
const RESPONSES_ADDRESS = "responses-contract-address";

/**
 * Known-good request record for a `transfer(vault, amount)` deposit — the
 * base every test uses. Shared across tests: NEVER mutate.
 */
const REQUEST: SignetEVMSignatureRequest = {
  requestNonce: 0n,
  evmTransaction: {
    to: bytes(20, 0xaa),
    chainId: 11155111n,
    nonce: 7n,
    gasLimit: 100_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    value: 0n,
  },
  calldata: {
    funcSig: asciiPadded("transfer(address,uint256)", 256),
    argCount: 2n,
    args: [
      bytes(32, 0),
      bigintToBytes32(1_000_000n),
      new Uint8Array(32),
      new Uint8Array(32),
    ],
  },
  mpcRouting: {
    caip2Id: asciiPadded("eip155:11155111", 64),
    keyVersion: 0n,
    path: new Uint8Array(256),
    algo: asciiPadded("ecdsa", 32),
    dest: asciiPadded("ethereum", 64),
    params: new Uint8Array(512),
    outputSchema: new Uint8Array(256),
    respondSchema: new Uint8Array(256),
  },
};

// The "MPC" of these tests: a plain secp256k1 key standing in for the user's
// derived signer, plus a second key playing the imposter.
const MPC_KEY = new SigningKey(`0x${"11".repeat(32)}`);
const MPC_ADDRESS = computeAddress(MPC_KEY.publicKey);
const IMPOSTER_KEY = new SigningKey(`0x${"22".repeat(32)}`);
const IMPOSTER_ADDRESS = computeAddress(IMPOSTER_KEY.publicKey);

/** Sign `REQUEST`'s rebuilt tx hash with `key`, packed as 65-byte r||s||v. */
const signResponse = (key: SigningKey): Uint8Array => {
  const signature = key.sign(buildUnsignedEvmTransaction(REQUEST).unsignedHash);
  const out = new Uint8Array(65);
  out.set(getBytes(signature.r), 0);
  out.set(getBytes(signature.s), 32);
  out[64] = signature.v;
  return out;
};

const GENUINE_RESPONSE = signResponse(MPC_KEY);
const IMPOSTER_RESPONSE = signResponse(IMPOSTER_KEY);
// All-zero r/s cannot decode into a signature at all.
const UNDECODABLE_RESPONSE = bytes(65, 0);

// ---- Synthetic ledger states (signet layout convention) ----

/** Requester state: request index (field 0) holding REQUEST, nonce (field 1). */
const requesterState = (): StateValue => {
  const map = new StateMap().insert(
    {
      value: requestIdType.toValue(REQUEST_ID),
      alignment: requestIdType.alignment(),
    },
    StateValue.newCell({
      value: signetEVMSignatureRequestType.toValue(REQUEST),
      alignment: signetEVMSignatureRequestType.alignment(),
    }),
  );
  return StateValue.newArray()
    .arrayPush(StateValue.newMap(map))
    .arrayPush(
      StateValue.newCell({ value: u64.toValue(1n), alignment: u64.alignment() }),
    );
};

/**
 * Responses state: counter index (field 0) and response log (field 1) for
 * REQUEST_ID. `counterOverride` forces a counter that disagrees with the
 * log, for the inconsistency test.
 */
const responsesState = (
  posts: Uint8Array[],
  counterOverride?: bigint,
): StateValue => {
  const total = counterOverride ?? BigInt(posts.length);
  let counterMap = new StateMap();
  if (total > 0n) {
    counterMap = counterMap.insert(
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
  let responseMap = new StateMap();
  posts.forEach((post, index) => {
    responseMap = responseMap.insert(
      {
        value: signatureResponseKeyType.toValue({
          count: BigInt(index),
          requestId: REQUEST_ID,
        }),
        alignment: signatureResponseKeyType.alignment(),
      },
      StateValue.newCell({
        value: bytes65.toValue(post),
        alignment: bytes65.alignment(),
      }),
    );
  });
  return StateValue.newArray()
    .arrayPush(StateValue.newMap(counterMap))
    .arrayPush(StateValue.newMap(responseMap));
};

// ---- Harness ----

/**
 * Build a reader over synthetic states, counting state-source queries so the
 * request-record caching is observable.
 */
const makeReader = (posts: Uint8Array[], counterOverride?: bigint) => {
  const queries = { requester: 0, responses: 0 };
  const publicDataProvider: SignetPublicStateSource = {
    queryContractState: async (contractAddress) => {
      if (contractAddress === REQUESTER_ADDRESS) {
        queries.requester += 1;
        return { data: requesterState() };
      }
      queries.responses += 1;
      return { data: responsesState(posts, counterOverride) };
    },
  };
  const reader = new SignetRequestResponseReader({
    requesterContractAddress: REQUESTER_ADDRESS,
    responsesContractAddress: RESPONSES_ADDRESS,
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
    await reader.getVerifiedSignatureResponse(REQUEST_ID_HEX, MPC_ADDRESS);
    expect(queries.requester).toBe(1);
  });

  it("throws when the requester contract has no state", async () => {
    const publicDataProvider: SignetPublicStateSource = {
      queryContractState: async () => null,
    };
    const reader = new SignetRequestResponseReader({
      requesterContractAddress: REQUESTER_ADDRESS,
      responsesContractAddress: RESPONSES_ADDRESS,
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
  posts: Uint8Array[];
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

describe("getVerifiedSignatureResponse", () => {
  it.each(VERDICT_CASES)(
    "resolves $name",
    async ({ posts, expectedSigner, verifiedPost, rejectedReasons }) => {
      const { reader } = makeReader(posts);
      const { verified, verdicts } = await reader.getVerifiedSignatureResponse(
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
