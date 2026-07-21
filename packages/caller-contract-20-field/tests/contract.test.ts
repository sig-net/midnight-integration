// Lockstep tests against REAL compiler output for a chunked (>15-field)
// ledger: 20 fields compile to a chunk tree (chunks of [5, 15], remainder
// first), and the raw readers in @sig-net/midnight must resolve flat field
// numbers through it exactly like the generated ledger() does. The synthetic
// chunked-state tests in signet-midnight emulate this layout by hand; THIS
// suite is what catches a compiler that changes its chunking rules.

import { describe, expect, it } from "vitest";

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";

import {
  calculateRequestId,
  lookupSignetRequestAt,
  readSignetRequestsLedgerFromState,
  requestIdHex,
  signetFieldNode,
  toSignBidirectionalEventIndex,
} from "@sig-net/midnight";

import { Contract, ledger } from "../src/index.ts";

// ---- Fixtures ----

// THIS contract's ledger layout (declaration order in
// signet-caller-20-field.compact): requestLog List at field 0, counter at
// field 1, filler counters at 2..18, request map at field 19. In raw state
// the compiler stores these as chunks of [5, 15], so fields 0..4 live in
// chunk 0 and fields 5..19 in chunk 1.
const REQUEST_LOG_FIELD = 0;
const NONCE_FIELD = 1;
const LAST_CHUNK0_FIELD = 4; // pad04, last slot of chunk 0
const FIRST_CHUNK1_FIELD = 5; // pad05, first slot of chunk 1
const REQUESTS_INDEX_FIELD = 19;

// Dummy coin public key (32-byte hex). Required by the API, unused here.
const CPK = "0".repeat(64);

// The caller-supplied circuit args of a valid submit.
const EVM_NONCE = 7n;
const KEY_VERSION = 1n;

// ---- Harness ----

const deployContract = async () => {
  const contract = new Contract({});
  const { currentContractState, currentPrivateState } =
    await contract.initialState(createConstructorContext(undefined, CPK));
  const ctx = createCircuitContext(
    "submitSignatureRequest",
    sampleContractAddress(),
    CPK,
    currentContractState,
    currentPrivateState,
  );
  return { contract, ctx };
};

// ---- Tests ----

describe("chunked ledger raw parsing (20 fields, REAL compiler output)", () => {
  it("resolves fields on both sides of the chunk boundary, fresh contract", async () => {
    const { ctx } = await deployContract();
    const raw = ctx.callContext.currentQueryContext.state;

    // The List at field 0 is itself array-typed: chunk detection must not
    // read it as a chunk level.
    expect(signetFieldNode(raw, REQUEST_LOG_FIELD).type()).toBe("array");
    expect(signetFieldNode(raw, NONCE_FIELD).type()).toBe("cell");
    expect(signetFieldNode(raw, LAST_CHUNK0_FIELD).type()).toBe("cell");
    expect(signetFieldNode(raw, FIRST_CHUNK1_FIELD).type()).toBe("cell");
    expect(signetFieldNode(raw, REQUESTS_INDEX_FIELD).type()).toBe("map");
    expect(() => signetFieldNode(raw, 20)).toThrow(/out of range/);

    const { nonce, requestsIndex } = readSignetRequestsLedgerFromState(
      raw,
      REQUESTS_INDEX_FIELD,
      NONCE_FIELD,
    );
    expect(nonce).toBe(0n);
    expect(requestsIndex.size).toBe(0);
  });

  it("stores a request readable identically via ledger() and the raw reader at field 19", async () => {
    const { contract, ctx } = await deployContract();

    const next = (
      await contract.circuits.submitSignatureRequest(ctx, EVM_NONCE, KEY_VERSION)
    ).context;
    const state = next.callContext.currentQueryContext.state;

    // Read 1: generated ledger() (knows the chunk tree at compile time).
    const typedIndex = toSignBidirectionalEventIndex(
      ledger(state).signBidirectionalEventMap,
    );
    // Read 2: MPC-style raw read by flat field number alone.
    const rawLedger = readSignetRequestsLedgerFromState(
      state,
      REQUESTS_INDEX_FIELD,
      NONCE_FIELD,
    );

    expect(typedIndex.size).toBe(1);
    expect(rawLedger.requestsIndex).toEqual(typedIndex);
    expect(rawLedger.nonce).toBe(ledger(state).signetRequestNonce);

    // Read 3: the discovery path's single-record lookup at the notified
    // field number.
    const [idHex, record] = [...typedIndex.entries()][0];
    expect(
      lookupSignetRequestAt(state, REQUESTS_INDEX_FIELD, idHex),
    ).toEqual(record);

    // The map key is the domain-separated hash of the record: the TS twin
    // recomputes it from the raw-read record.
    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));
  });
});
