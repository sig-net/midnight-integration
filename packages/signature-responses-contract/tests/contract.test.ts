// Simulator-level unit tests: the contract runs entirely in-process via
// @midnight-ntwrk/compact-runtime — no ledger, no network, no proving.

import { describe, expect, it } from "vitest";

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
  type CircuitContext,
} from "@midnight-ntwrk/compact-runtime";

import {
  Contract,
  createResponsesPrivateState,
  ledger,
  pureCircuits,
  witnesses,
  type ResponsesPrivateState,
} from "../src/index.ts";

// ---- Fixtures ----

// Dummy coin public key (32-byte hex). Required by the API, unused here.
const CPK = "0".repeat(64);

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

// Identity secrets for the simulated owner and for a stranger.
const SECRET_KEY = bytes(32, 7);
const OTHER_SECRET_KEY = bytes(32, 8);

// Commitments computed via the COMPILED circuit
const OWNER_COMMITMENT = pureCircuits.ownerCommittment(SECRET_KEY);
const OTHER_COMMITMENT = pureCircuits.ownerCommittment(OTHER_SECRET_KEY);

const REQUEST_ID = bytes(32, 0xaa);
const RESPONSE = bytes(32, 0xbb);
const OTHER_RESPONSE = bytes(32, 0xcc);

// ---- Harness ----

const deployContract = (secretKey: Uint8Array = SECRET_KEY) => {
  const contract = new Contract<ResponsesPrivateState>(witnesses);
  const { currentContractState, currentPrivateState } = contract.initialState(
    createConstructorContext<ResponsesPrivateState>(createResponsesPrivateState(secretKey), CPK),
  );
  const ctx = createCircuitContext(
    sampleContractAddress(),
    CPK,
    currentContractState,
    currentPrivateState,
  );
  return { contract, ctx };
};

/** Deploy + initialise() as the owner; returns the ready context. */
const deployInitialised = () => {
  const { contract, ctx } = deployContract();
  const next = contract.circuits.initialise(ctx).context;
  return { contract, ctx: next };
};

/** The same contract state, but the caller's private state holds a stranger's secret. */
const asStranger = (ctx: CircuitContext<ResponsesPrivateState>): CircuitContext<ResponsesPrivateState> => ({
  ...ctx,
  currentPrivateState: createResponsesPrivateState(OTHER_SECRET_KEY),
});

// ---- Tests ----

describe("ownerCommittment", () => {
  it("check 32-byte commitments computed off-chain via the compiled circuit", () => {
    expect(OWNER_COMMITMENT).toHaveLength(32);
    expect(OWNER_COMMITMENT).not.toEqual(new Uint8Array(32));
    expect(OWNER_COMMITMENT).not.toEqual(OTHER_COMMITMENT);
  });
});

describe("initialise", () => {
  it("starts unowned with an empty index", () => {
    const { ctx } = deployContract();

    const l = ledger(ctx.currentQueryContext.state);
    expect(l.owner.is_some).toBe(false);
    expect(l.signatureResponseIndex.isEmpty()).toBe(true);
  });

  it("seals the caller's commitment as owner", () => {
    const { ctx } = deployInitialised();

    const l = ledger(ctx.currentQueryContext.state);
    expect(l.owner.is_some).toBe(true);
    expect(l.owner.value).toEqual(OWNER_COMMITMENT);
  });

  it("is one-shot", () => {
    const { contract, ctx } = deployInitialised();
    expect(() => contract.circuits.initialise(ctx)).toThrow(/already been intialised/);
  });
});

describe("postResponse", () => {
  it("rejects before initialise", () => {
    const { contract, ctx } = deployContract();
    expect(() => contract.circuits.postResponse(ctx, REQUEST_ID, RESPONSE)).toThrow(
      /not yet intialised/,
    );
  });

  it("rejects a caller whose secret does not match the owner commitment", () => {
    const { contract, ctx } = deployInitialised();
    expect(() => contract.circuits.postResponse(asStranger(ctx), REQUEST_ID, RESPONSE)).toThrow(
      /Only the owner/,
    );
  });

  it("stores the response under the request id", () => {
    const { contract, ctx } = deployInitialised();

    const next = contract.circuits.postResponse(ctx, REQUEST_ID, RESPONSE).context;

    const index = ledger(next.currentQueryContext.state).signatureResponseIndex;
    expect(index.size()).toBe(1n);
    expect(index.member(REQUEST_ID)).toBe(true);
    expect(index.lookup(REQUEST_ID)).toEqual(RESPONSE);
  });

  it("re-posting the same value is a no-op, not an error", () => {
    const { contract, ctx } = deployInitialised();

    let next = contract.circuits.postResponse(ctx, REQUEST_ID, RESPONSE).context;
    next = contract.circuits.postResponse(next, REQUEST_ID, RESPONSE).context;

    const index = ledger(next.currentQueryContext.state).signatureResponseIndex;
    expect(index.size()).toBe(1n);
    expect(index.lookup(REQUEST_ID)).toEqual(RESPONSE);
  });

  it("re-posting a DIFFERENT value for a stored request id is rejected", () => {
    const { contract, ctx } = deployInitialised();

    const next = contract.circuits.postResponse(ctx, REQUEST_ID, RESPONSE).context;

    expect(() => contract.circuits.postResponse(next, REQUEST_ID, OTHER_RESPONSE)).toThrow(
      /differs from given value/,
    );
  });
});
