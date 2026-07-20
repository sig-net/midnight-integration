// Simulator-level unit tests: the contract runs entirely in-process via
// @midnight-ntwrk/compact-runtime — no ledger, no network, no proving. The
// stage-2 suite signs REAL attestations (signAttestation + the compiled
// signetAttestationMessage circuit), so postRespondBidirectional's in-circuit
// secp256k1 ECDSA verification is exercised end to end.

import { describe, expect, it } from "vitest";

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";

import {
  bigintToBytes32,
  bytesToBigint,
  bytesToHex,
  decodeSignBidirectionalNotification,
  ecdsaSignatureToLeBytes,
  hashSecp256k1Point,
  readSignetContractLedgerFromState,
  requestIdHex,
  SECP256K1_ORDER,
  secp256k1PublicKeyFromSecretKey,
  signAttestation,
  pureCircuits as signetCircuits,
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

// The "MPC" of these tests (its key is pinned at deploy) and an imposter,
// each a fixed secp256k1 secret key (< n, non-zero) used directly — the same
// "root key IS the secp private key" convention the fakenet holds.
const MPC_SECRET_KEY = bytes(32, 0x42);
const IMPOSTER_SECRET_KEY = bytes(32, 0x43);
const MPC_PK = secp256k1PublicKeyFromSecretKey(MPC_SECRET_KEY);
const IMPOSTER_PK = secp256k1PublicKeyFromSecretKey(IMPOSTER_SECRET_KEY);

// A successful remote execution: first byte 1 (the LE encoding the circuits
// decode as `as Field == 1`), rest zero; 32 meaningful bytes (one ABI word).
const OUTPUT_SUCCESS = new Uint8Array(128);
OUTPUT_SUCCESS[0] = 1;
const OUTPUT_SUCCESS_LEN = 32n;

/**
 * Sign a REAL ECDSA attestation of (requestId, serializedOutput, outputLen)
 * with `secretKey` — the digest comes from the compiled circuit, exactly like
 * the MPC. Returns the ledger-shaped record (r/s as little-endian bytes); the
 * signing public key is presented separately to the circuit.
 */
const attest = (
  secretKey: Uint8Array,
  requestId: Uint8Array,
  serializedOutput: Uint8Array,
  outputLen: bigint = OUTPUT_SUCCESS_LEN,
): RespondBidirectional => {
  const digest = signetCircuits.signetAttestationMessage(
    requestId,
    serializedOutput,
    outputLen,
  );
  const { sigR, sigS } = ecdsaSignatureToLeBytes(signAttestation(digest, secretKey));
  return { serializedOutput, outputLen, sigR, sigS };
};

/**
 * The malleated twin of an attestation: same r, but s replaced with n - s.
 * secp256k1EcdsaVerify does not enforce low-s, so the twin verifies too, yet
 * its bytes differ — a second, equally valid record over the same output,
 * which is what the first-write-wins test needs (ECDSA signing is otherwise
 * deterministic).
 */
const malleate = (attestation: RespondBidirectional): RespondBidirectional => ({
  ...attestation,
  sigS: bigintToBytes32(SECP256K1_ORDER - bytesToBigint(attestation.sigS)),
});

// ---- Harness ----

const deployContract = async (circuitId: string) => {
  const contract = new Contract<SignetContractPrivateState>(witnesses);
  const { currentContractState, currentPrivateState } =
    await contract.initialState(
      createConstructorContext(createSignetContractPrivateState(), CPK),
      MPC_PK,
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
    expect(state.mpcPubKeyHash).toEqual(hashSecp256k1Point(MPC_PK));
    expect(state.signBidirectionalNotificationIndex.isEmpty()).toBe(true);
  });
});

// A caller contract address as the packer consumes it (raw 32 bytes) — the
// registering client passes kernel.self(); here a fixed fixture suffices.
const NOTIFYING_CALLER = { bytes: bytes(32, 0xc1) };

describe("notifyBidirectionalSignatureRequest", () => {
  it("stores the notification under its request id — observable on the ledger", async () => {
    const { contract, ctx } = await deployContract(
      "notifyBidirectionalSignatureRequest",
    );
    const notification = signetCircuits.constructSignBidirectionalNotificationV1(
      NOTIFYING_CALLER,
      REQUEST_A,
      0n,
    );

    const next = (
      await contract.circuits.notifyBidirectionalSignatureRequest(
        ctx,
        REQUEST_A,
        notification,
      )
    ).context;
    const state = ledger(next.callContext.currentQueryContext.state);

    expect(state.signBidirectionalNotificationIndex.size()).toBe(1n);
    expect(state.signBidirectionalNotificationIndex.lookup(REQUEST_A)).toEqual(
      notification,
    );
  });

  it("overwrites idempotently on a repeat notify for the same request id", async () => {
    const { contract, ctx } = await deployContract(
      "notifyBidirectionalSignatureRequest",
    );
    const first = signetCircuits.constructSignBidirectionalNotificationV1(
      NOTIFYING_CALLER,
      REQUEST_A,
      0n,
    );
    const second = signetCircuits.constructSignBidirectionalNotificationV1(
      NOTIFYING_CALLER,
      REQUEST_A,
      3n, // different index field — latest write must win
    );

    let next = (
      await contract.circuits.notifyBidirectionalSignatureRequest(
        ctx,
        REQUEST_A,
        first,
      )
    ).context;
    next = (
      await contract.circuits.notifyBidirectionalSignatureRequest(
        next,
        REQUEST_A,
        second,
      )
    ).context;

    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.signBidirectionalNotificationIndex.size()).toBe(1n);
    expect(state.signBidirectionalNotificationIndex.lookup(REQUEST_A)).toEqual(
      second,
    );
  });

  it("MPC-style raw read decodes the stored notification from real contract state", async () => {
    const { contract, ctx } = await deployContract(
      "notifyBidirectionalSignatureRequest",
    );
    const notification = signetCircuits.constructSignBidirectionalNotificationV1(
      NOTIFYING_CALLER,
      REQUEST_A,
      0n,
    );
    const next = (
      await contract.circuits.notifyBidirectionalSignatureRequest(
        ctx,
        REQUEST_A,
        notification,
      )
    ).context;

    // Read the REAL simulator state the way the MPC reads the indexer's raw
    // state: by field position, through the hand-composed descriptors. This
    // pins descriptor↔contract encoding lockstep in-process.
    const raw = readSignetContractLedgerFromState(
      next.callContext.currentQueryContext.state,
    );
    expect(raw.signBidirectionalNotificationIndex.size).toBe(1);
    const record = raw.signBidirectionalNotificationIndex.get(
      requestIdHex(REQUEST_A),
    );
    expect(record).toBeDefined();
    expect(decodeSignBidirectionalNotification(record!)).toEqual({
      version: 1,
      callerAddress: bytesToHex(NOTIFYING_CALLER.bytes),
      requestId: requestIdHex(REQUEST_A),
      requestsIndexField: 0,
    });
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
    const attestation = attest(MPC_SECRET_KEY, REQUEST_A, OUTPUT_SUCCESS);

    const next = (
      await contract.circuits.postRespondBidirectional(
        ctx,
        REQUEST_A,
        attestation,
        MPC_PK,
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

  it("rejects an attestation presenting a key other than the pinned MPC key", async () => {
    const { contract, ctx } = await deployContract("postRespondBidirectional");
    const attestation = attest(IMPOSTER_SECRET_KEY, REQUEST_A, OUTPUT_SUCCESS);
    await expect(
      contract.circuits.postRespondBidirectional(ctx, REQUEST_A, attestation, IMPOSTER_PK),
    ).rejects.toThrow(/attestation pk is not the MPC key/);
  });

  it("rejects a signature by a non-MPC key presented under the MPC key", async () => {
    const { contract, ctx } = await deployContract("postRespondBidirectional");
    // Signed by the imposter but claiming to be the MPC key: the key hash
    // passes, the signature does not.
    const attestation = attest(IMPOSTER_SECRET_KEY, REQUEST_A, OUTPUT_SUCCESS);
    await expect(
      contract.circuits.postRespondBidirectional(ctx, REQUEST_A, attestation, MPC_PK),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a tampered attestation (output differs from what was signed)", async () => {
    const { contract, ctx } = await deployContract("postRespondBidirectional");
    const attestation = attest(MPC_SECRET_KEY, REQUEST_A, OUTPUT_SUCCESS);
    const tamperedOutput = new Uint8Array(OUTPUT_SUCCESS);
    tamperedOutput[100] = 0xff;
    await expect(
      contract.circuits.postRespondBidirectional(ctx, REQUEST_A, {
        ...attestation,
        serializedOutput: tamperedOutput,
      }, MPC_PK),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a tampered attestation (output length differs from what was signed)", async () => {
    const { contract, ctx } = await deployContract("postRespondBidirectional");
    const attestation = attest(MPC_SECRET_KEY, REQUEST_A, OUTPUT_SUCCESS);
    await expect(
      contract.circuits.postRespondBidirectional(ctx, REQUEST_A, {
        ...attestation,
        outputLen: attestation.outputLen + 1n,
      }, MPC_PK),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a genuine attestation replayed under a DIFFERENT request id", async () => {
    const { contract, ctx } = await deployContract("postRespondBidirectional");
    const attestation = attest(MPC_SECRET_KEY, REQUEST_A, OUTPUT_SUCCESS);
    await expect(
      contract.circuits.postRespondBidirectional(ctx, REQUEST_B, attestation, MPC_PK),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("accepts the high-s malleated twin: the verifier does NOT enforce low-s", async () => {
    const { contract, ctx } = await deployContract("postRespondBidirectional");
    const twin = malleate(attest(MPC_SECRET_KEY, REQUEST_A, OUTPUT_SUCCESS));

    const next = (
      await contract.circuits.postRespondBidirectional(ctx, REQUEST_A, twin, MPC_PK)
    ).context;
    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.respondBidirectionalIndex.size()).toBe(1n);
    expect(state.respondBidirectionalIndex.lookup(REQUEST_A)).toEqual(twin);
  });

  it("first valid write wins: a re-posted twin is a no-op, not an overwrite", async () => {
    const { contract, ctx } = await deployContract("postRespondBidirectional");
    const first = attest(MPC_SECRET_KEY, REQUEST_A, OUTPUT_SUCCESS);
    // ECDSA signing is deterministic (RFC 6979), so the malleated twin is a
    // DIFFERENT, equally valid record over the same output.
    const second = malleate(first);
    expect(second.sigS).not.toEqual(first.sigS);

    let next = (
      await contract.circuits.postRespondBidirectional(ctx, REQUEST_A, first, MPC_PK)
    ).context;
    next = (
      await contract.circuits.postRespondBidirectional(next, REQUEST_A, second, MPC_PK)
    ).context;

    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.respondBidirectionalIndex.size()).toBe(1n);
    expect(state.respondBidirectionalIndex.lookup(REQUEST_A)).toEqual(first);
  });

  it("tracks attestations per request id", async () => {
    const { contract, ctx } = await deployContract("postRespondBidirectional");
    const forA = attest(MPC_SECRET_KEY, REQUEST_A, OUTPUT_SUCCESS);
    const forB = attest(MPC_SECRET_KEY, REQUEST_B, OUTPUT_SUCCESS);

    let next = (
      await contract.circuits.postRespondBidirectional(ctx, REQUEST_A, forA, MPC_PK)
    ).context;
    next = (
      await contract.circuits.postRespondBidirectional(next, REQUEST_B, forB, MPC_PK)
    ).context;

    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.respondBidirectionalIndex.size()).toBe(2n);
    expect(state.respondBidirectionalIndex.lookup(REQUEST_A)).toEqual(forA);
    expect(state.respondBidirectionalIndex.lookup(REQUEST_B)).toEqual(forB);
  });
});
