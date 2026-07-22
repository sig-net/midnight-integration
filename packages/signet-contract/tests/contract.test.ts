// Simulator-level unit tests: the contract runs entirely in-process via
// @midnight-ntwrk/compact-runtime — no ledger, no network, no proving. Every
// store on this contract is an UNAUTHENTICATED append-only log: nothing is
// verified in circuit, each post lands under the next (requestId, count) key,
// and verification is deliberately the reader's job. The tests pin exactly
// that: garbage lands too, nothing overwrites, counters and entries agree.

import { describe, expect, it } from "vitest";

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";

import {
  bytesToHex,
  decodeSignBidirectionalNotification,
  bigintToBytes32,
  readSignetContractLedgerFromState,
  requestIdHex,
  signetMapEntryKey,
  pureCircuits as signetCircuits,
  type SignatureRespondedEvent,
  type RespondBidirectionalEvent,
} from "@sig-net/midnight";

import {
  Contract,
  createSignetContractPrivateState,
  ledger,
  witnesses,
  type SignetContractPrivateState,
} from "../src/index.ts";

// ---- Fixtures ----

// Dummy coin public key (32-byte hex). Required by the API, unused here.
const CPK = "0".repeat(64);

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

// Request ids the posts below answer, and signature response records.
const REQUEST_A = bytes(32, 0xaa);
const REQUEST_B = bytes(32, 0xbb);
const SIG_1: SignatureRespondedEvent = {
  bigRx: bytes(32, 0x01),
  bigRy: bytes(32, 0x02),
  s: bytes(32, 0x03),
  recoveryId: 0n,
};
const SIG_2: SignatureRespondedEvent = {
  bigRx: bytes(32, 0x04),
  bigRy: bytes(32, 0x05),
  s: bytes(32, 0x06),
  recoveryId: 1n,
};

// Respond-bidirectional records: SYNTHETIC signatures, deliberately not
// verifiable — the contract must store them anyway (verification is the
// reader's job, not this contract's).
const OUTPUT_SUCCESS = (() => {
  const out = new Uint8Array(128);
  out[0] = 1;
  return out;
})();
const RESPOND_1: RespondBidirectionalEvent = {
  serializedOutput: OUTPUT_SUCCESS,
  outputLen: 32n,
  r: bigintToBytes32(111n),
  s: bigintToBytes32(222n),
  recoveryId: 0n,
};
const RESPOND_2: RespondBidirectionalEvent = {
  serializedOutput: bytes(128, 0x5a),
  outputLen: 64n,
  r: bigintToBytes32(333n),
  s: bigintToBytes32(444n),
  recoveryId: 1n,
};

// A caller contract address as the packer consumes it (raw 32 bytes) — the
// registering client passes kernel.self(); here a fixed fixture suffices.
const NOTIFYING_CALLER = { bytes: bytes(32, 0xc1) };

// ---- Harness ----

const deployContract = async (circuitId: string) => {
  const contract = new Contract<SignetContractPrivateState>(witnesses);
  const { currentContractState, currentPrivateState } =
    await contract.initialState(
      createConstructorContext(createSignetContractPrivateState(), CPK),
    );
  const ctx = createCircuitContext(
    circuitId,
    sampleContractAddress(),
    CPK,
    currentContractState,
    currentPrivateState,
  );
  return { contract, ctx };
};

// ---- Tests ----

describe("constructor", () => {
  it("deploys with all six maps empty", async () => {
    const { ctx } = await deployContract("postSignatureResponse");
    const state = ledger(ctx.callContext.currentQueryContext.state);
    expect(state.signBidirectionalEventNotificationCounterMap.isEmpty()).toBe(true);
    expect(state.signBidirectionalEventNotificationMap.isEmpty()).toBe(true);
    expect(state.signatureResponseCounterMap.isEmpty()).toBe(true);
    expect(state.signatureResponseMap.isEmpty()).toBe(true);
    expect(state.respondBidirectionalCounterMap.isEmpty()).toBe(true);
    expect(state.respondBidirectionalMap.isEmpty()).toBe(true);
  });
});

describe("signBidirectionalEvent", () => {
  const notification = (requestsIndexField: bigint) =>
    signetCircuits.constructSignBidirectionalEventNotificationV1(
      NOTIFYING_CALLER,
      requestsIndexField,
    );

  it("stores the notification under (requestId, 0) and returns that map key", async () => {
    const { contract, ctx } = await deployContract("signBidirectionalEvent");

    const { result, context } = await contract.circuits.signBidirectionalEvent(
      ctx,
      REQUEST_A,
      notification(4n),
    );
    const state = ledger(context.callContext.currentQueryContext.state);

    expect(result).toEqual({ count: 0n, requestId: REQUEST_A });
    expect(
      state.signBidirectionalEventNotificationCounterMap.lookup(REQUEST_A).read(),
    ).toBe(1n);
    expect(state.signBidirectionalEventNotificationMap.size()).toBe(1n);
    expect(
      state.signBidirectionalEventNotificationMap.lookup({
        count: 0n,
        requestId: REQUEST_A,
      }),
    ).toEqual(notification(4n));
  });

  it("appends a repeat notify under the next count — nothing overwritten", async () => {
    const { contract, ctx } = await deployContract("signBidirectionalEvent");

    const first = await contract.circuits.signBidirectionalEvent(
      ctx,
      REQUEST_A,
      notification(4n),
    );
    const second = await contract.circuits.signBidirectionalEvent(
      first.context,
      REQUEST_A,
      notification(7n), // different index field — both posts must survive
    );

    expect(second.result).toEqual({ count: 1n, requestId: REQUEST_A });
    const state = ledger(second.context.callContext.currentQueryContext.state);
    expect(
      state.signBidirectionalEventNotificationCounterMap.lookup(REQUEST_A).read(),
    ).toBe(2n);
    expect(state.signBidirectionalEventNotificationMap.size()).toBe(2n);
    expect(
      state.signBidirectionalEventNotificationMap.lookup({
        count: 0n,
        requestId: REQUEST_A,
      }),
    ).toEqual(notification(4n));
    expect(
      state.signBidirectionalEventNotificationMap.lookup({
        count: 1n,
        requestId: REQUEST_A,
      }),
    ).toEqual(notification(7n));
  });

  it("rejects a notification whose version is not 1", async () => {
    const { contract, ctx } = await deployContract("signBidirectionalEvent");
    await expect(
      contract.circuits.signBidirectionalEvent(ctx, REQUEST_A, {
        ...notification(4n),
        version: 2n,
      }),
    ).rejects.toThrow(/only version 1 notification supported/);
  });

  it("MPC-style raw read decodes the stored notification from real contract state", async () => {
    const { contract, ctx } = await deployContract("signBidirectionalEvent");
    const { context } = await contract.circuits.signBidirectionalEvent(
      ctx,
      REQUEST_A,
      notification(4n),
    );

    // Read the REAL simulator state the way the MPC reads the indexer's raw
    // state: by field position, through the hand-composed descriptors. This
    // pins descriptor↔contract encoding lockstep in-process.
    const raw = readSignetContractLedgerFromState(
      context.callContext.currentQueryContext.state,
    );
    expect(raw.signBidirectionalEventNotificationMap.size).toBe(1);
    const record = raw.signBidirectionalEventNotificationMap.get(
      requestIdHex(REQUEST_A),
    );
    expect(record).toBeDefined();
    expect(decodeSignBidirectionalNotification(record!)).toEqual({
      version: 1,
      callerAddress: bytesToHex(NOTIFYING_CALLER.bytes),
      requestsIndexField: 4,
    });
  });
});

/** One posted (requestId, signature) pair, applied in row order. */
interface Post {
  requestId: Uint8Array;
  signature: SignatureRespondedEvent;
}

/** One row of the post table: a post sequence → the exact expected ledger. */
interface PostCase {
  /** Test name, completing the sentence "stores <name>". */
  name: string;
  /** Posts applied in order, each through postSignatureResponse. */
  posts: Post[];
  /** The FULL expected counter map: total posts per request id. */
  expectedCounters: { requestId: Uint8Array; total: bigint }[];
  /** The FULL expected response log: (requestId, count) → signature. */
  expectedEntries: {
    requestId: Uint8Array;
    count: bigint;
    signature: SignatureRespondedEvent;
  }[];
}

const POST_CASES: PostCase[] = [
  {
    name: "a single post at count 0, its counter reading 1",
    posts: [{ requestId: REQUEST_A, signature: SIG_1 }],
    expectedCounters: [{ requestId: REQUEST_A, total: 1n }],
    expectedEntries: [{ requestId: REQUEST_A, count: 0n, signature: SIG_1 }],
  },
  {
    name: "a second post for the same request APPENDED, the first untouched",
    posts: [
      { requestId: REQUEST_A, signature: SIG_1 },
      { requestId: REQUEST_A, signature: SIG_2 },
    ],
    expectedCounters: [{ requestId: REQUEST_A, total: 2n }],
    expectedEntries: [
      { requestId: REQUEST_A, count: 0n, signature: SIG_1 },
      { requestId: REQUEST_A, count: 1n, signature: SIG_2 },
    ],
  },
  {
    name: "an identical re-post as its own entry (no dedup, no error)",
    posts: [
      { requestId: REQUEST_A, signature: SIG_1 },
      { requestId: REQUEST_A, signature: SIG_1 },
    ],
    expectedCounters: [{ requestId: REQUEST_A, total: 2n }],
    expectedEntries: [
      { requestId: REQUEST_A, count: 0n, signature: SIG_1 },
      { requestId: REQUEST_A, count: 1n, signature: SIG_1 },
    ],
  },
  {
    name: "independent per-request counts for interleaved posts",
    posts: [
      { requestId: REQUEST_A, signature: SIG_1 },
      { requestId: REQUEST_B, signature: SIG_2 },
      { requestId: REQUEST_A, signature: SIG_2 },
    ],
    expectedCounters: [
      { requestId: REQUEST_A, total: 2n },
      { requestId: REQUEST_B, total: 1n },
    ],
    expectedEntries: [
      { requestId: REQUEST_A, count: 0n, signature: SIG_1 },
      { requestId: REQUEST_A, count: 1n, signature: SIG_2 },
      { requestId: REQUEST_B, count: 0n, signature: SIG_2 },
    ],
  },
];

describe("postSignatureResponse", () => {
  it.each(POST_CASES)(
    "stores $name",
    async ({ posts, expectedCounters, expectedEntries }) => {
      const { contract, ctx } = await deployContract("postSignatureResponse");

      let finalCtx = ctx;
      for (const { requestId, signature } of posts) {
        finalCtx = (
          await contract.circuits.postSignatureResponse(
            finalCtx,
            requestId,
            signature,
          )
        ).context;
      }
      const state = ledger(finalCtx.callContext.currentQueryContext.state);

      // The counter map holds EXACTLY the expected requests, each counter
      // reading that request's total number of posts.
      expect(state.signatureResponseCounterMap.size()).toBe(
        BigInt(expectedCounters.length),
      );
      for (const { requestId, total } of expectedCounters) {
        expect(state.signatureResponseCounterMap.lookup(requestId).read()).toBe(
          total,
        );
      }

      // The response log holds EXACTLY the expected (requestId, count) keys.
      expect(state.signatureResponseMap.size()).toBe(
        BigInt(expectedEntries.length),
      );
      for (const { requestId, count, signature } of expectedEntries) {
        expect(state.signatureResponseMap.lookup({ count, requestId })).toEqual(
          signature,
        );
      }
    },
  );
});

describe("postRespondBidirectional", () => {
  it("stores a post under (requestId, 0) — UNVERIFIED by design", async () => {
    const { contract, ctx } = await deployContract("postRespondBidirectional");

    const { context } = await contract.circuits.postRespondBidirectional(
      ctx,
      REQUEST_A,
      RESPOND_1,
    );
    const state = ledger(context.callContext.currentQueryContext.state);

    expect(state.respondBidirectionalCounterMap.lookup(REQUEST_A).read()).toBe(1n);
    expect(state.respondBidirectionalMap.size()).toBe(1n);
    // The synthetic (unverifiable) signature landed verbatim: the contract
    // stores, the reader verifies.
    expect(
      state.respondBidirectionalMap.lookup({ count: 0n, requestId: REQUEST_A }),
    ).toEqual(RESPOND_1);
  });

  it("appends a second post for the same request — nothing overwritten", async () => {
    const { contract, ctx } = await deployContract("postRespondBidirectional");

    const first = await contract.circuits.postRespondBidirectional(
      ctx,
      REQUEST_A,
      RESPOND_1,
    );
    const second = await contract.circuits.postRespondBidirectional(
      first.context,
      REQUEST_A,
      RESPOND_2,
    );

    const state = ledger(second.context.callContext.currentQueryContext.state);
    expect(state.respondBidirectionalCounterMap.lookup(REQUEST_A).read()).toBe(2n);
    expect(state.respondBidirectionalMap.size()).toBe(2n);
    expect(
      state.respondBidirectionalMap.lookup({ count: 0n, requestId: REQUEST_A }),
    ).toEqual(RESPOND_1);
    expect(
      state.respondBidirectionalMap.lookup({ count: 1n, requestId: REQUEST_A }),
    ).toEqual(RESPOND_2);
  });

  it("tracks posts per request id", async () => {
    const { contract, ctx } = await deployContract("postRespondBidirectional");

    const first = await contract.circuits.postRespondBidirectional(
      ctx,
      REQUEST_A,
      RESPOND_1,
    );
    const second = await contract.circuits.postRespondBidirectional(
      first.context,
      REQUEST_B,
      RESPOND_2,
    );

    const state = ledger(second.context.callContext.currentQueryContext.state);
    expect(state.respondBidirectionalCounterMap.lookup(REQUEST_A).read()).toBe(1n);
    expect(state.respondBidirectionalCounterMap.lookup(REQUEST_B).read()).toBe(1n);
    expect(
      state.respondBidirectionalMap.lookup({ count: 0n, requestId: REQUEST_A }),
    ).toEqual(RESPOND_1);
    expect(
      state.respondBidirectionalMap.lookup({ count: 0n, requestId: REQUEST_B }),
    ).toEqual(RESPOND_2);
  });

  it("MPC-style raw read agrees with the generated ledger()", async () => {
    const { contract, ctx } = await deployContract("postRespondBidirectional");
    const { context } = await contract.circuits.postRespondBidirectional(
      ctx,
      REQUEST_A,
      RESPOND_1,
    );

    const raw = readSignetContractLedgerFromState(
      context.callContext.currentQueryContext.state,
    );
    expect(raw.respondBidirectionalCounterMap.get(requestIdHex(REQUEST_A))).toBe(1n);
    expect(
      raw.respondBidirectionalMap.get(
        signetMapEntryKey(requestIdHex(REQUEST_A), 0n),
      ),
    ).toEqual(RESPOND_1);
  });
});
