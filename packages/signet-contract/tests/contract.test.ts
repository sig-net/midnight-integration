// Simulator-level unit tests: the contract runs entirely in-process via
// @midnight-ntwrk/compact-runtime — no ledger, no network, no proving. The
// stage-2 suite signs REAL attestations (schnorrSign + the compiled
// schnorrChallenge/signetAttestationMessage circuits), so
// postRemoteExecutionResponse's in-circuit Schnorr verification is exercised
// end to end.

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
  type SignetRemoteExecutionResponse,
} from "@midnight-erc20-vault/signet-midnight";

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

// Request ids the posts below answer, and 65-byte r||s||v signatures.
const REQUEST_A = bytes(32, 0xaa);
const REQUEST_B = bytes(32, 0xbb);
const SIG_1 = bytes(65, 0x01);
const SIG_2 = bytes(65, 0x02);

// The "MPC" of these tests (its key is pinned at deploy), and an imposter.
const MPC_KEYS = deriveJubjubKeypair(bytes(32, 0x42));
const IMPOSTER_KEYS = deriveJubjubKeypair(bytes(32, 0x43));

// A successful remote execution: first byte 1 (the LE encoding the circuits
// decode as `as Field == 1`), rest zero.
const OUTPUT_SUCCESS = new Uint8Array(4096);
OUTPUT_SUCCESS[0] = 1;

/**
 * Sign a REAL attestation of (requestId, outputData) with `keys` — message
 * and challenge both come from the compiled circuits, exactly like the MPC.
 */
const attest = (
  keys: JubjubKeypair,
  requestId: Uint8Array,
  outputData: Uint8Array,
): SignetRemoteExecutionResponse => {
  const msg = signetCircuits.signetAttestationMessage(requestId, outputData);
  const signature = schnorrSign(keys.sk, msg, (ax, ay, px, py, m) =>
    signetCircuits.schnorrChallenge(ax, ay, px, py, m),
  );
  return {
    outputData,
    pk: keys.pk,
    announcement: signature.announcement,
    response: signature.response,
  };
};

// ---- Harness ----

const deployContract = () => {
  const contract = new Contract<SignetContractPrivateState>(witnesses);
  const { currentContractState, currentPrivateState } = contract.initialState(
    createConstructorContext(createSignetContractPrivateState(), CPK),
    MPC_KEYS.pk,
  );
  const ctx = createCircuitContext(
    sampleContractAddress(),
    CPK,
    currentContractState,
    currentPrivateState,
  );
  return { contract, ctx };
};

// ---- Tests ----

describe("constructor", () => {
  it("deploys with empty indexes and the MPC key hash sealed", () => {
    const { ctx } = deployContract();
    const state = ledger(ctx.currentQueryContext.state);
    expect(state.signatureResponseCounterIndex.isEmpty()).toBe(true);
    expect(state.signatureResponseIndex.isEmpty()).toBe(true);
    expect(state.remoteExecutionResponseIndex.isEmpty()).toBe(true);
    expect(state.mpcPubKeyHash).toEqual(hashJubjubPoint(MPC_KEYS.pk));
  });
});

/** One posted (requestId, signature) pair, applied in row order. */
interface Post {
  requestId: Uint8Array;
  signature: Uint8Array;
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
    signature: Uint8Array;
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
    ({ posts, expectedCounters, expectedEntries }) => {
      const { contract, ctx } = deployContract();

      const finalCtx = posts.reduce(
        (acc, { requestId, signature }) =>
          contract.circuits.postSignatureResponse(acc, requestId, signature)
            .context,
        ctx,
      );
      const state = ledger(finalCtx.currentQueryContext.state);

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

describe("postRemoteExecutionResponse", () => {
  it("stores a genuine attestation — the ledger record parses into the shared twin type", () => {
    const { contract, ctx } = deployContract();
    const attestation = attest(MPC_KEYS, REQUEST_A, OUTPUT_SUCCESS);

    const next = contract.circuits.postRemoteExecutionResponse(
      ctx,
      REQUEST_A,
      attestation,
    ).context;
    const state = ledger(next.currentQueryContext.state);

    expect(state.remoteExecutionResponseIndex.size()).toBe(1n);
    // The assignment is the real assertion: the generated ledger type must
    // stay structurally identical to the shared library's named twin.
    const stored: SignetRemoteExecutionResponse =
      state.remoteExecutionResponseIndex.lookup(REQUEST_A);
    expect(stored).toEqual(attestation);
  });

  it("rejects an attestation by a key other than the pinned MPC key", () => {
    const { contract, ctx } = deployContract();
    const attestation = attest(IMPOSTER_KEYS, REQUEST_A, OUTPUT_SUCCESS);
    expect(() =>
      contract.circuits.postRemoteExecutionResponse(ctx, REQUEST_A, attestation),
    ).toThrow(/attestation pk is not the MPC key/);
  });

  it("rejects a tampered attestation (output data differs from what was signed)", () => {
    const { contract, ctx } = deployContract();
    const attestation = attest(MPC_KEYS, REQUEST_A, OUTPUT_SUCCESS);
    const tamperedOutput = new Uint8Array(OUTPUT_SUCCESS);
    tamperedOutput[100] = 0xff;
    expect(() =>
      contract.circuits.postRemoteExecutionResponse(ctx, REQUEST_A, {
        ...attestation,
        outputData: tamperedOutput,
      }),
    ).toThrow(/Invalid attestation signature/);
  });

  it("rejects a genuine attestation replayed under a DIFFERENT request id", () => {
    const { contract, ctx } = deployContract();
    const attestation = attest(MPC_KEYS, REQUEST_A, OUTPUT_SUCCESS);
    expect(() =>
      contract.circuits.postRemoteExecutionResponse(ctx, REQUEST_B, attestation),
    ).toThrow(/Invalid attestation signature/);
  });

  it("first valid write wins: a re-signed duplicate is a no-op, not an overwrite", () => {
    const { contract, ctx } = deployContract();
    const first = attest(MPC_KEYS, REQUEST_A, OUTPUT_SUCCESS);
    // Schnorr is randomized: a second signature over the SAME output is a
    // different, equally valid record.
    const second = attest(MPC_KEYS, REQUEST_A, OUTPUT_SUCCESS);
    expect(second.announcement).not.toEqual(first.announcement);

    let next = contract.circuits.postRemoteExecutionResponse(
      ctx,
      REQUEST_A,
      first,
    ).context;
    next = contract.circuits.postRemoteExecutionResponse(
      next,
      REQUEST_A,
      second,
    ).context;

    const state = ledger(next.currentQueryContext.state);
    expect(state.remoteExecutionResponseIndex.size()).toBe(1n);
    expect(state.remoteExecutionResponseIndex.lookup(REQUEST_A)).toEqual(first);
  });

  it("tracks attestations per request id", () => {
    const { contract, ctx } = deployContract();
    const forA = attest(MPC_KEYS, REQUEST_A, OUTPUT_SUCCESS);
    const forB = attest(MPC_KEYS, REQUEST_B, OUTPUT_SUCCESS);

    let next = contract.circuits.postRemoteExecutionResponse(
      ctx,
      REQUEST_A,
      forA,
    ).context;
    next = contract.circuits.postRemoteExecutionResponse(
      next,
      REQUEST_B,
      forB,
    ).context;

    const state = ledger(next.currentQueryContext.state);
    expect(state.remoteExecutionResponseIndex.size()).toBe(2n);
    expect(state.remoteExecutionResponseIndex.lookup(REQUEST_A)).toEqual(forA);
    expect(state.remoteExecutionResponseIndex.lookup(REQUEST_B)).toEqual(forB);
  });
});
