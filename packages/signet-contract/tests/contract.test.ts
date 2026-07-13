// Simulator-level unit tests: the contract runs entirely in-process via
// @midnight-ntwrk/compact-runtime — no ledger, no network, no proving. The
// stage-2 suite signs REAL attestations (schnorrSign + the compiled
// schnorrChallenge/signetAttestationMessage circuits), so
// postRespondBidirectional's in-circuit Schnorr verification is exercised
// end to end.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";

import {
  deriveJubjubKeypair,
  hashJubjubPoint,
  schnorrSign,
  pureCircuits as signetCircuits,
  type JubjubKeypair,
  type SignatureResponse,
  type RespondBidirectional,
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
const SIG_1: SignatureResponse = {
  bigRx: bytes(32, 0x01),
  bigRy: bytes(32, 0x02),
  s: bytes(32, 0x03),
  recoveryId: 0n,
};
const SIG_2: SignatureResponse = {
  bigRx: bytes(32, 0x04),
  bigRy: bytes(32, 0x05),
  s: bytes(32, 0x06),
  recoveryId: 1n,
};

// The "MPC" of these tests (its key is pinned at deploy), and an imposter.
const MPC_KEYS = deriveJubjubKeypair(bytes(32, 0x42));
const IMPOSTER_KEYS = deriveJubjubKeypair(bytes(32, 0x43));

// A successful remote execution: first byte 1 (the LE encoding the circuits
// decode as `as Field == 1`), rest zero; 32 meaningful bytes (one ABI word).
const OUTPUT_SUCCESS = new Uint8Array(128);
OUTPUT_SUCCESS[0] = 1;
const OUTPUT_SUCCESS_LEN = 32n;

/**
 * Sign a REAL attestation of (requestId, serializedOutput, outputLen) with
 * `keys` — message and challenge both come from the compiled circuits,
 * exactly like the MPC.
 */
const attest = (
  keys: JubjubKeypair,
  requestId: Uint8Array,
  serializedOutput: Uint8Array,
  outputLen: bigint = OUTPUT_SUCCESS_LEN,
): RespondBidirectional => {
  const msg = signetCircuits.signetAttestationMessage(
    requestId,
    serializedOutput,
    outputLen,
  );
  const signature = schnorrSign(keys.sk, msg, (ax, ay, px, py, m) =>
    signetCircuits.schnorrChallenge(ax, ay, px, py, m),
  );
  return {
    serializedOutput,
    outputLen,
    pk: keys.pk,
    announcement: signature.announcement,
    response: signature.response,
  };
};

// ---- Harness ----

const deployContract = async (circuitId: string) => {
  const contract = new Contract<SignetContractPrivateState>(witnesses);
  const { currentContractState, currentPrivateState } =
    await contract.initialState(
      createConstructorContext(createSignetContractPrivateState(), CPK),
      MPC_KEYS.pk,
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
  it("deploys with empty indexes and the MPC key hash sealed", async () => {
    const { ctx } = await deployContract("postSignatureResponse");
    const state = ledger(ctx.callContext.currentQueryContext.state);
    expect(state.signatureResponseCounterIndex.isEmpty()).toBe(true);
    expect(state.signatureResponseIndex.isEmpty()).toBe(true);
    expect(state.respondBidirectionalIndex.isEmpty()).toBe(true);
    expect(state.mpcPubKeyHash).toEqual(hashJubjubPoint(MPC_KEYS.pk));
  });
});

/** One posted (requestId, signature) pair, applied in row order. */
interface Post {
  requestId: Uint8Array;
  signature: SignatureResponse;
}

/** One row of the post table: a post sequence → the exact expected ledger. */
interface PostCase {
  /** Test name, completing the sentence "stores <name>". */
  name: string;
  /** Posts applied in order, each through postSignatureResponse. */
  posts: Post[];
  /** The FULL expected counter index: total posts per request id. */
  expectedCounters: { requestId: Uint8Array; total: bigint }[];
  /** The FULL expected response log: (requestId, count) → signature. */
  expectedEntries: {
    requestId: Uint8Array;
    count: bigint;
    signature: SignatureResponse;
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

      // The counter index holds EXACTLY the expected requests, each counter
      // reading that request's total number of posts.
      expect(state.signatureResponseCounterIndex.size()).toBe(
        BigInt(expectedCounters.length),
      );
      for (const { requestId, total } of expectedCounters) {
        expect(
          state.signatureResponseCounterIndex.lookup(requestId).read(),
        ).toBe(total);
      }

      // The response log holds EXACTLY the expected (requestId, count) keys.
      expect(state.signatureResponseIndex.size()).toBe(
        BigInt(expectedEntries.length),
      );
      for (const { requestId, count, signature } of expectedEntries) {
        expect(
          state.signatureResponseIndex.lookup({ count, requestId }),
        ).toEqual(signature);
      }
    },
  );
});

describe("postRespondBidirectional", () => {
  it("stores a genuine attestation — the ledger record parses into the shared twin type", async () => {
    const { contract, ctx } = await deployContract("postRespondBidirectional");
    const attestation = attest(MPC_KEYS, REQUEST_A, OUTPUT_SUCCESS);

    const next = (
      await contract.circuits.postRespondBidirectional(
        ctx,
        REQUEST_A,
        attestation,
      )
    ).context;
    const state = ledger(next.callContext.currentQueryContext.state);

    expect(state.respondBidirectionalIndex.size()).toBe(1n);
    // The assignment is the real assertion: the generated ledger type must
    // stay structurally identical to the shared library's named twin.
    const stored: RespondBidirectional =
      state.respondBidirectionalIndex.lookup(REQUEST_A);
    expect(stored).toEqual(attestation);
  });

  it("rejects an attestation by a key other than the pinned MPC key", async () => {
    const { contract, ctx } = await deployContract("postRespondBidirectional");
    const attestation = attest(IMPOSTER_KEYS, REQUEST_A, OUTPUT_SUCCESS);
    await expect(
      contract.circuits.postRespondBidirectional(ctx, REQUEST_A, attestation),
    ).rejects.toThrow(/attestation pk is not the MPC key/);
  });

  it("rejects a tampered attestation (output differs from what was signed)", async () => {
    const { contract, ctx } = await deployContract("postRespondBidirectional");
    const attestation = attest(MPC_KEYS, REQUEST_A, OUTPUT_SUCCESS);
    const tamperedOutput = new Uint8Array(OUTPUT_SUCCESS);
    tamperedOutput[100] = 0xff;
    await expect(
      contract.circuits.postRespondBidirectional(ctx, REQUEST_A, {
        ...attestation,
        serializedOutput: tamperedOutput,
      }),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a tampered attestation (output length differs from what was signed)", async () => {
    const { contract, ctx } = await deployContract("postRespondBidirectional");
    const attestation = attest(MPC_KEYS, REQUEST_A, OUTPUT_SUCCESS);
    await expect(
      contract.circuits.postRespondBidirectional(ctx, REQUEST_A, {
        ...attestation,
        outputLen: attestation.outputLen + 1n,
      }),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a genuine attestation replayed under a DIFFERENT request id", async () => {
    const { contract, ctx } = await deployContract("postRespondBidirectional");
    const attestation = attest(MPC_KEYS, REQUEST_A, OUTPUT_SUCCESS);
    await expect(
      contract.circuits.postRespondBidirectional(ctx, REQUEST_B, attestation),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("first valid write wins: a re-signed duplicate is a no-op, not an overwrite", async () => {
    const { contract, ctx } = await deployContract("postRespondBidirectional");
    const first = attest(MPC_KEYS, REQUEST_A, OUTPUT_SUCCESS);
    // Schnorr is randomized: a second signature over the SAME output is a
    // different, equally valid record.
    const second = attest(MPC_KEYS, REQUEST_A, OUTPUT_SUCCESS);
    expect(second.announcement).not.toEqual(first.announcement);

    let next = (
      await contract.circuits.postRespondBidirectional(ctx, REQUEST_A, first)
    ).context;
    next = (
      await contract.circuits.postRespondBidirectional(next, REQUEST_A, second)
    ).context;

    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.respondBidirectionalIndex.size()).toBe(1n);
    expect(state.respondBidirectionalIndex.lookup(REQUEST_A)).toEqual(first);
  });

  it("compiled emit: the circuit lowers to an event (`log`) transcript op", () => {
    // Event DELIVERY is unobservable in-process — the emitted event lands in
    // the circuit's public transcript behind an opaque WASM handle; only a
    // live indexer surfaces it (the golden e2e test pins that, plus the
    // payload byte layout). What CAN be pinned here: the emit statement was
    // accepted at compile time — the generated circuit body carries the
    // event op. Scoped to postRespondBidirectional's own method so the other
    // circuits' emits cannot mask a regression.
    const js = readFileSync(
      fileURLToPath(new URL("../src/managed/contract/index.js", import.meta.url)),
      "utf8",
    );
    const start = js.indexOf("async _postRespondBidirectional_0(");
    expect(start).toBeGreaterThan(-1);
    expect(js.slice(start)).toContain("'log'");
  });

  it("tracks attestations per request id", async () => {
    const { contract, ctx } = await deployContract("postRespondBidirectional");
    const forA = attest(MPC_KEYS, REQUEST_A, OUTPUT_SUCCESS);
    const forB = attest(MPC_KEYS, REQUEST_B, OUTPUT_SUCCESS);

    let next = (
      await contract.circuits.postRespondBidirectional(ctx, REQUEST_A, forA)
    ).context;
    next = (
      await contract.circuits.postRespondBidirectional(next, REQUEST_B, forB)
    ).context;

    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.respondBidirectionalIndex.size()).toBe(2n);
    expect(state.respondBidirectionalIndex.lookup(REQUEST_A)).toEqual(forA);
    expect(state.respondBidirectionalIndex.lookup(REQUEST_B)).toEqual(forB);
  });
});
