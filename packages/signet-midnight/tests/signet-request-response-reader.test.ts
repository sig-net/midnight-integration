// SignetRequestResponseReader over stub sources: the requester ledger is
// encoded with the canonical descriptors into a StateValue tree (the shape
// the indexer returns) and served through a stub state source; the signet
// contract's responses are served as decoded events through a stub event
// source (built by the test-local encode twins in signet-event-fixtures.ts).
// No network, no compiled contract.

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
  calculateSignetAttestationDigest,
  ecdsaSignatureToMpcSignature,
  evmAddressAbiWord,
  numericAbiWord,
  secp256k1PublicKeyOf,
  signAttestationDigest,
  signatureToSignatureRespondedEvent,
  signBidirectionalEventToSignedEvmTransaction,
  signBidirectionalEventToUnsignedEvmTransaction,
  requestIdHex,
  requestIdType,
  signBidirectionalEventDescriptor,
  SignetRequestResponseReader,
  type SignBidirectionalEvent,
  type SignatureRespondedEvent,
  type SignetMiscEvent,
  type SignetPublicStateSource,
  type RespondBidirectionalEvent,
} from "../src/index.ts";

import {
  respondBidirectionalEventOf,
  signatureRespondedEventOf,
} from "./signet-event-fixtures.ts";

// The ERC20 transfer(address,uint256) selector: a realistic calldata fixture
// (the app-level constant lives in the cli).
const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

// ---- Fixtures ----

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

const u64 = new CompactTypeUnsignedInteger(18446744073709551615n, 8);

/** The sample request's capacities (the vault's EvmType2TxParams<2, 0, 0>). */
const REQUEST_DESCRIPTOR = signBidirectionalEventDescriptor(2, 0, 0, 34, 34);

const REQUEST_ID = bytes(32, 0x2f);
const REQUEST_ID_HEX = requestIdHex(REQUEST_ID);
const UNKNOWN_ID_HEX = requestIdHex(bytes(32, 0x30));

const REQUESTER_ADDRESS = "requester-contract-address";
const SIGNET_CONTRACT_ADDRESS = "signet-contract-address";

/**
 * Known-good request record for a `transfer(vault, amount)` deposit: the
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
      signBidirectionalEventToUnsignedEvmTransaction(REQUEST).unsignedHash,
    ),
  );

const GENUINE_RESPONSE = signResponse(MPC_KEY);
const IMPOSTER_RESPONSE = signResponse(IMPOSTER_KEY);
// A recovery id byte of 5 cannot decode into a signature at all.
const UNDECODABLE_RESPONSE: SignatureRespondedEvent = {
  signature: { ...GENUINE_RESPONSE.signature, recoveryId: 5n },
};

// ---- Synthetic requester ledger state (signet layout convention) ----

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

// A respond-bidirectional record for the response tests: a synthetic
// signature (the reader decodes, verification is the CLIENT's job).
const RESPOND_BIDIRECTIONAL: RespondBidirectionalEvent = {
  signature: { bigR: { x: bytes(32, 0x5c), y: bytes(32, 0x5d) }, s: bytes(32, 0x5e), recoveryId: 1n },
};

// The MPC response key of the requesting contract, and a genuinely signed
// attestation of ATTESTED_OUTPUT under it: what the verified getter must
// pick out of the event log (RESPOND_BIDIRECTIONAL above is the garbage post
// it must reject).
const MPC_RESPONSE_SECRET = bytes(32, 0x11);
const MPC_RESPONSE_KEY = secp256k1PublicKeyOf(MPC_RESPONSE_SECRET);
const ATTESTED_OUTPUT = Uint8Array.from([1]);
const ATTESTED_RESPOND_BIDIRECTIONAL: RespondBidirectionalEvent = {
  signature: ecdsaSignatureToMpcSignature(
    signAttestationDigest(
      calculateSignetAttestationDigest(REQUEST_ID, ATTESTED_OUTPUT),
      MPC_RESPONSE_SECRET,
    ),
  ),
};

// ---- Harness ----

/**
 * Build a reader over the synthetic requester state and the given emitted
 * events, counting state-source queries so the request-record caching is
 * observable. Signature responses and respond-bidirectional posts land in
 * ONE event log (as on chain), each under its own event name.
 */
const makeReader = (
  posts: SignatureRespondedEvent[],
  respondBidirectionalPosts: RespondBidirectionalEvent[] = [],
) => {
  const queries = { requester: 0, events: 0 };
  const publicDataProvider: SignetPublicStateSource = {
    queryContractState: async (contractAddress) => {
      expect(contractAddress).toBe(REQUESTER_ADDRESS);
      queries.requester += 1;
      return { data: requesterState() };
    },
  };
  const events: SignetMiscEvent[] = [
    ...posts.map(signatureRespondedEventOf),
    ...respondBidirectionalPosts.map(respondBidirectionalEventOf),
  ];
  const reader = new SignetRequestResponseReader({
    requesterContractAddress: REQUESTER_ADDRESS,
    requesterRequestsPath: [0],
    signetContractAddress: SIGNET_CONTRACT_ADDRESS,
    publicDataProvider,
    eventSource: {
      querySignetEvents: async (contractAddress) => {
        expect(contractAddress).toBe(SIGNET_CONTRACT_ADDRESS);
        queries.events += 1;
        return events;
      },
    },
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
    const reader = new SignetRequestResponseReader({
      requesterContractAddress: REQUESTER_ADDRESS,
      requesterRequestsPath: [0],
      signetContractAddress: SIGNET_CONTRACT_ADDRESS,
      publicDataProvider: { queryContractState: async () => null },
      eventSource: { querySignetEvents: async () => [] },
    });
    await expect(reader.getSignatureRequest(REQUEST_ID_HEX)).rejects.toThrow(
      /is it deployed/,
    );
  });
});

describe("getSignatureRespondedEvents", () => {
  it("returns every emitted response in emission order", async () => {
    const { reader } = makeReader([UNDECODABLE_RESPONSE, GENUINE_RESPONSE]);
    expect(await reader.getSignatureRespondedEvents()).toEqual([
      UNDECODABLE_RESPONSE,
      GENUINE_RESPONSE,
    ]);
  });

  it("returns an empty array when nothing is posted", async () => {
    const { reader } = makeReader([]);
    expect(await reader.getSignatureRespondedEvents()).toEqual([]);
  });

  it("ignores events under other signet names", async () => {
    const { reader } = makeReader([GENUINE_RESPONSE], [RESPOND_BIDIRECTIONAL]);
    expect(await reader.getSignatureRespondedEvents()).toEqual([
      GENUINE_RESPONSE,
    ]);
  });
});

/** One row of the verdict table: emitted responses → expected result. */
interface VerdictCase {
  /** Test name, completing the sentence "resolves <name>". */
  name: string;
  /** The posts in the event log, in emission order. */
  posts: SignatureRespondedEvent[];
  /** The signer verification demands. */
  expectedSigner: string;
  /** Index of the post expected as `verified`; absent = none valid. */
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
    name: "a genuine post behind noise: first VALID wins, noise gets reasons",
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
    name: "only an imposter post: nothing verifies",
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
        expect(verdict.index).toBe(BigInt(index));
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

describe("getUnsignedEvmTransaction", () => {
  it("rebuilds the request's unsigned transaction", async () => {
    const { reader, queries } = makeReader([]);
    const tx = await reader.getUnsignedEvmTransaction(REQUEST_ID_HEX);

    expect(tx.isSigned()).toBe(false);
    expect(tx.unsignedHash).toBe(
      signBidirectionalEventToUnsignedEvmTransaction(REQUEST).unsignedHash,
    );
    // Unsigned needs only the request record: it never touches the event log.
    expect(queries.events).toBe(0);
  });

  it("throws for a request id not on the ledger", async () => {
    const { reader } = makeReader([]);
    await expect(
      reader.getUnsignedEvmTransaction(UNKNOWN_ID_HEX),
    ).rejects.toThrow(/not on the requester contract's ledger/);
  });
});

describe("getSignedEvmTransaction", () => {
  it("attaches the first verified response, ready to broadcast", async () => {
    const { reader } = makeReader([IMPOSTER_RESPONSE, GENUINE_RESPONSE]);
    const tx = await reader.getSignedEvmTransaction(REQUEST_ID_HEX, MPC_ADDRESS);

    expect(tx?.isSigned()).toBe(true);
    expect(tx?.from).toBe(MPC_ADDRESS);
    // Identical to assembling it directly from the request and genuine post.
    expect(tx?.serialized).toBe(
      signBidirectionalEventToSignedEvmTransaction(REQUEST, GENUINE_RESPONSE)
        .serialized,
    );
  });

  it("returns undefined when no posted response verifies", async () => {
    const { reader } = makeReader([IMPOSTER_RESPONSE, UNDECODABLE_RESPONSE]);
    expect(
      await reader.getSignedEvmTransaction(REQUEST_ID_HEX, MPC_ADDRESS),
    ).toBeUndefined();
  });

  it("returns undefined when nothing is posted yet", async () => {
    const { reader } = makeReader([]);
    expect(
      await reader.getSignedEvmTransaction(REQUEST_ID_HEX, MPC_ADDRESS),
    ).toBeUndefined();
  });
});

describe("getRespondBidirectionalEvents", () => {
  it("returns the emitted responses in emission order", async () => {
    const { reader } = makeReader([], [
      RESPOND_BIDIRECTIONAL,
      ATTESTED_RESPOND_BIDIRECTIONAL,
    ]);
    expect(await reader.getRespondBidirectionalEvents()).toEqual([
      RESPOND_BIDIRECTIONAL,
      ATTESTED_RESPOND_BIDIRECTIONAL,
    ]);
  });

  it("returns an empty array when nothing is posted yet", async () => {
    const { reader } = makeReader([]);
    expect(await reader.getRespondBidirectionalEvents()).toEqual([]);
  });

  it("ignores events under other signet names", async () => {
    const { reader } = makeReader([GENUINE_RESPONSE], [RESPOND_BIDIRECTIONAL]);
    expect(await reader.getRespondBidirectionalEvents()).toEqual([
      RESPOND_BIDIRECTIONAL,
    ]);
  });
});

describe("getVerifiedRespondBidirectionalEvent", () => {
  it("picks the post that attests the output, past the garbage in front of it", async () => {
    const { reader } = makeReader([], [
      RESPOND_BIDIRECTIONAL,
      ATTESTED_RESPOND_BIDIRECTIONAL,
    ]);
    expect(
      await reader.getVerifiedRespondBidirectionalEvent(
        REQUEST_ID_HEX,
        ATTESTED_OUTPUT,
        MPC_RESPONSE_KEY,
      ),
    ).toEqual(ATTESTED_RESPOND_BIDIRECTIONAL);
  });

  it("returns undefined when the attested output is not the one presented", async () => {
    const { reader } = makeReader([], [ATTESTED_RESPOND_BIDIRECTIONAL]);
    expect(
      await reader.getVerifiedRespondBidirectionalEvent(
        REQUEST_ID_HEX,
        Uint8Array.from([0]),
        MPC_RESPONSE_KEY,
      ),
    ).toBeUndefined();
  });

  it("returns undefined when nothing is posted yet", async () => {
    const { reader } = makeReader([]);
    expect(
      await reader.getVerifiedRespondBidirectionalEvent(
        REQUEST_ID_HEX,
        ATTESTED_OUTPUT,
        MPC_RESPONSE_KEY,
      ),
    ).toBeUndefined();
  });
});
