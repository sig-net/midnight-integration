// Lockstep tests against REAL compiler output for a chunked (>15-field)
// ledger: 20 fields compile to a chunk tree (chunks of [5, 15], remainder
// first). A notification carries the resolved path compactc records for a
// field in contract-info.json, and the raw readers in @sig-net/midnight follow
// it exactly like the generated ledger() does. Every path here is READ from
// that same contract-info.json rather than hardcoded, so this suite catches a
// compiler that changes its chunking rules: the pinned assertions below fail
// the moment a field's recorded path moves.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  signetFieldNodeByPath,
  toSignBidirectionalEventIndex,
} from "@sig-net/midnight";
import { describe, expect, it } from "vitest";

import { Contract, ledger } from "../src/index.ts";

// ---- Fixtures ----

// The compiler's own resolved ledger paths, read from the generated
// contract-info.json (`index` is a bare number at depth 1, an array when
// chunked). This is the exact value a notification would carry, so following
// it is what the MPC does.
interface LedgerFieldInfo {
  name: string;
  index: number | number[];
}
const CONTRACT_INFO = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../src/managed/compiler/contract-info.json", import.meta.url)),
    "utf8",
  ),
) as { ledger: LedgerFieldInfo[] };

const fieldPath = (name: string): number[] => {
  const field = CONTRACT_INFO.ledger.find((f) => f.name === name);
  if (field === undefined) {
    throw new Error(`no ledger field named ${name} in contract-info.json`);
  }
  return Array.isArray(field.index) ? field.index : [field.index];
};

// THIS contract's ledger layout (declaration order in
// test-caller-contract-20-field.compact): requestLog List at field 0, counter
// at field 1, filler counters at 2..18, request map at field 19. compactc
// stores these as chunks of [5, 15], so fields 0..4 live in chunk 0 and fields
// 5..19 in chunk 1.
const REQUEST_LOG_PATH = fieldPath("requestLog");
const NONCE_PATH = fieldPath("signetRequestNonce");
const LAST_CHUNK0_PATH = fieldPath("pad04"); // last slot of chunk 0
const FIRST_CHUNK1_PATH = fieldPath("pad05"); // first slot of chunk 1
const REQUESTS_INDEX_PATH = fieldPath("signBidirectionalEventMap");

// Dummy coin public key (32-byte hex). Required by the API, unused here.
const CPK = "0".repeat(64);

// The caller-supplied circuit args of a valid submit.
const EVM_NONCE = 7n;
const KEY_VERSION = 1n;

// ---- Harness ----

const deployContract = async () => {
  const contract = new Contract<undefined>({});
  const { currentContractState, currentPrivateState } = await contract.initialState(
    createConstructorContext(undefined, CPK),
  );
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
  it("follows compiler paths on both sides of the chunk boundary, fresh contract", async () => {
    const { ctx } = await deployContract();
    const raw = ctx.callContext.currentQueryContext.state;

    // Pin the compiler's chunking: remainder-first [5, 15] puts field 0 at
    // chunk [0, 0] and field 19 at [1, 14]. A change to these fails here.
    expect(REQUEST_LOG_PATH).toEqual([0, 0]);
    expect(FIRST_CHUNK1_PATH).toEqual([1, 0]);
    expect(REQUESTS_INDEX_PATH).toEqual([1, 14]);

    // The List at [0, 0] is itself array-typed: path-following never mistakes
    // it for a chunk level.
    expect(signetFieldNodeByPath(raw, REQUEST_LOG_PATH).type()).toBe("array");
    expect(signetFieldNodeByPath(raw, NONCE_PATH).type()).toBe("cell");
    expect(signetFieldNodeByPath(raw, LAST_CHUNK0_PATH).type()).toBe("cell");
    expect(signetFieldNodeByPath(raw, FIRST_CHUNK1_PATH).type()).toBe("cell");
    expect(signetFieldNodeByPath(raw, REQUESTS_INDEX_PATH).type()).toBe("map");
    // Chunk 1 holds 15 slots (0..14), so slot 15 is past the end.
    expect(() => signetFieldNodeByPath(raw, [1, 15])).toThrow(/out of range/);

    const { nonce, requestsIndex } = readSignetRequestsLedgerFromState(
      raw,
      REQUESTS_INDEX_PATH,
      NONCE_PATH,
    );
    expect(nonce).toBe(0n);
    expect(requestsIndex.size).toBe(0);
  });

  it("stores a request readable identically via ledger() and the raw reader at path [1, 14]", async () => {
    const { contract, ctx } = await deployContract();

    const next = (await contract.circuits.submitSignatureRequest(ctx, EVM_NONCE, KEY_VERSION))
      .context;
    const state = next.callContext.currentQueryContext.state;

    // Read 1: generated ledger() (knows the chunk tree at compile time).
    const typedIndex = toSignBidirectionalEventIndex(ledger(state).signBidirectionalEventMap);
    // Read 2: MPC-style raw read by the compiler's resolved path alone.
    const rawLedger = readSignetRequestsLedgerFromState(state, REQUESTS_INDEX_PATH, NONCE_PATH);

    expect(typedIndex.size).toBe(1);
    expect(rawLedger.requestsIndex).toEqual(typedIndex);
    expect(rawLedger.nonce).toBe(ledger(state).signetRequestNonce);

    // Read 3: the discovery path's single-record lookup at the notified path.
    const entry = [...typedIndex.entries()][0];
    if (entry === undefined) throw new Error("the size assertion above proves this is unreachable");
    const [idHex, record] = entry;
    expect(lookupSignetRequestAt(state, REQUESTS_INDEX_PATH, idHex)).toEqual(record);

    // The map key is the domain-separated hash of the record: the TS twin
    // recomputes it from the raw-read record.
    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));
  });
});
