// Simulator-level unit tests: the contract runs entirely in-process via
// @midnight-ntwrk/compact-runtime — no ledger, no network, no proving.

import { describe, expect, it } from "vitest";

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";

import {
  asciiPadded,
  calculateRequestId,
  deriveJubjubKeypair,
  pureCircuits as signetCircuits,
  readSignetRequestsLedgerFromState,
  requestIdBytes,
  requestIdHex,
  schnorrSign,
  signetFieldNode,
  toSignBidirectionalRequestIndex,
  type JubjubKeypair,
  type RespondBidirectional,
  type SignBidirectionalRequestLedgerIndex,
} from "@sig-net/midnight";

import { Contract, ledger, witnesses, type CallerPrivateState } from "../src/index.ts";
import { createCallerPrivateState } from "../src/witnesses.ts";
// The signet contract (callee) module — the same one the caller's generated
// code cross-contract-calls. submitSignatureRequest ends in a call to its
// notifyBidirectionalSignatureRequest, so the simulator needs its state (see
// signetStateProvider) to execute that path.
import * as SignetNotifier from "../src/managed/SignetNotifier/contract/index.js";

// ---- Fixtures ----

// THIS contract's ledger layout (declaration order in signet-caller.compact):
// requestLog List at field 0, counter at field 1, request index at field 4.
// The index position must match the `4 as Uint<8>` requestsIndexField the
// contract passes in submitSignatureRequest's notification.
const REQUEST_LOG_FIELD = 0;
const NONCE_FIELD = 1;
const REQUESTS_INDEX_FIELD = 4;

// Dummy coin public key (32-byte hex). Required by the API, unused here.
const CPK = "0".repeat(64);

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

// The "MPC" of these tests: its attestation key is pinned by the constructor.
const MPC_KEYS = deriveJubjubKeypair(bytes(32, 0x42));

// The signet contract (callee) the caller seals + cross-contract-calls. A
// valid sample contract address so the runtime's address checks pass.
const SIGNET_ADDRESS = sampleContractAddress();
const SIGNET_CONTRACT_REF = {
  bytes: Uint8Array.from(Buffer.from(SIGNET_ADDRESS, "hex")),
};
const BLOCK_HASH = "0".repeat(64);

/**
 * A ContractStateProvider serving the signet contract's initial state to the
 * simulator's cross-contract call — how submitSignatureRequest reaches
 * notifyBidirectionalSignatureRequest in-process (no node/indexer). Returns
 * the state for any address: the caller only calls the single sealed signet
 * contract.
 */
const signetStateProvider = async () => {
  const signet = new SignetNotifier.Contract({});
  const { currentContractState } = await signet.initialState(
    createConstructorContext(undefined, CPK),
    MPC_KEYS.pk,
  );
  return { getContractState: async () => currentContractState };
};

// The simulated caller's own contract address.
const CALLER_ADDRESS = sampleContractAddress();

// The contract-fixed request constants (mirrors of the in-circuit literals in
// signet-caller.compact; the round-trip test below is the lockstep check).
const EXPECTED_TO = asciiPadded("signet-caller-e2e-to", 20);
const EXPECTED_SELECTOR = new Uint8Array([0xca, 0x11, 0xab, 0x1e]);
const EXPECTED_WORD = asciiPadded("signet-caller:fixed-word", 32);
const EXPECTED_CAIP2 = asciiPadded("eip155:31337", 32);
const EXPECTED_PATH = asciiPadded("caller", 256);
const EXPECTED_ROUTING = {
  algo: asciiPadded("ecdsa", 32),
  dest: asciiPadded("ethereum", 32),
  params: new Uint8Array(64),
  outputDeserializationSchema: asciiPadded('[{"name":"success","type":"bool"}]', 128),
  respondSerializationSchema: asciiPadded('[{"name":"success","type":"bool"}]', 128),
};

// The caller-supplied circuit args of a valid submit.
const EVM_NONCE = 7n;
const KEY_VERSION = 1n;

// ---- Harness ----

const deployContract = async () => {
  const contract = new Contract<CallerPrivateState>(witnesses);
  const { currentContractState, currentPrivateState } =
    await contract.initialState(
      createConstructorContext<CallerPrivateState>(createCallerPrivateState(), CPK),
      MPC_KEYS.pk,
      SIGNET_CONTRACT_REF,
    );
  const ctx = createCircuitContext(
    "submitSignatureRequest",
    CALLER_ADDRESS,
    CPK,
    currentContractState,
    currentPrivateState,
    await signetStateProvider(),
    undefined,
    undefined,
    undefined,
    BLOCK_HASH,
  );
  return { contract, ctx };
};

/**
 * Deploy + submitSignatureRequest(EVM_NONCE, KEY_VERSION): the arrange step
 * of every verifyResponse test. Returns the pending request's id (the single
 * ledger index key) alongside the threaded context.
 */
const requestSubmitted = async () => {
  const { contract, ctx } = await deployContract();
  const next = (await contract.circuits.submitSignatureRequest(ctx, EVM_NONCE, KEY_VERSION)).context;
  const index = toSignBidirectionalRequestIndex(
    ledger(next.callContext.currentQueryContext.state).signetRequestsIndex,
  );
  const [idHex] = [...index.keys()];
  return { contract, ctx: next, requestId: requestIdBytes(idHex) };
};

// ---- Tests ----

describe("signet-caller ledger shape", () => {
  it("signetRequestsIndex parses into the shared signet-midnight types", async () => {
    const { ctx } = await deployContract();

    // The assignment is the real assertion: the generated ledger type must
    // stay structurally identical to the shared library's named types.
    const ledgerIndex: SignBidirectionalRequestLedgerIndex = ledger(
      ctx.callContext.currentQueryContext.state,
    ).signetRequestsIndex;

    expect(ledgerIndex.isEmpty()).toBe(true);
    expect(toSignBidirectionalRequestIndex(ledgerIndex).size).toBe(0);
  });

  it("MPC-style: finds the request index in RAW state by position, no ledger()", async () => {
    const { ctx } = await deployContract();

    const rawState = ctx.callContext.currentQueryContext.state;
    // The List at field 0 is array-typed exactly like a chunked field root;
    // resolving the index behind it is the point of this layout.
    expect(signetFieldNode(rawState, REQUEST_LOG_FIELD).type()).toBe("array");
    const node = signetFieldNode(rawState, REQUESTS_INDEX_FIELD);
    expect(node.type()).toBe("map");

    const { nonce, requestsIndex } = readSignetRequestsLedgerFromState(
      rawState,
      REQUESTS_INDEX_FIELD,
      NONCE_FIELD,
    );
    const typedIndex = toSignBidirectionalRequestIndex(
      ledger(ctx.callContext.currentQueryContext.state).signetRequestsIndex,
    );
    expect(requestsIndex).toEqual(typedIndex);
    expect(requestsIndex.size).toBe(0);
    expect(nonce).toBe(0n);
  });
});

describe("submitSignatureRequest round-trip", () => {
  it("stores a fully contract-composed request readable identically via ledger(), the shared parser, and the RAW reader", async () => {
    const { contract, ctx } = await deployContract();

    const next = (await contract.circuits.submitSignatureRequest(ctx, EVM_NONCE, KEY_VERSION)).context;
    const state = next.callContext.currentQueryContext.state;

    // Read 1: generated ledger().
    const typedIndex = toSignBidirectionalRequestIndex(
      ledger(state).signetRequestsIndex,
    );
    // Read 2: MPC-style raw read — no compiled contract involved.
    const rawLedger = readSignetRequestsLedgerFromState(
      state,
      REQUESTS_INDEX_FIELD,
      NONCE_FIELD,
    );

    expect(typedIndex.size).toBe(1);
    expect(rawLedger.requestsIndex).toEqual(typedIndex);
    expect(rawLedger.nonce).toBe(ledger(state).signetNonce);

    const [idHex, record] = [...typedIndex.entries()][0];

    // The contract-composed envelope: the fixed placeholder recipient on the
    // fixed dev chain, no ETH value, the contract-fixed gas envelope, the
    // caller's nonce.
    const { calldata, ...envelope } = record.txParams;
    expect(envelope).toEqual({
      to: EXPECTED_TO,
      chainId: 31337n,
      nonce: EVM_NONCE,
      gasLimit: 100000n,
      maxFeePerGas: 30000000000n,
      maxPriorityFeePerGas: 1000000000n,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
    });

    // The contract-fixed request fields come back exactly as the TS mirrors
    // expect — the LOCKSTEP CHECK for the in-circuit literals (including the
    // escaped JSON schema).
    expect(record.caip2Id).toEqual(EXPECTED_CAIP2);
    expect(record.keyVersion).toBe(KEY_VERSION);
    expect(record.path).toEqual(EXPECTED_PATH);
    expect(record.algo).toEqual(EXPECTED_ROUTING.algo);
    expect(record.dest).toEqual(EXPECTED_ROUTING.dest);
    expect(record.params).toEqual(EXPECTED_ROUTING.params);
    expect(record.outputDeserializationSchema).toEqual(
      EXPECTED_ROUTING.outputDeserializationSchema,
    );
    expect(record.respondSerializationSchema).toEqual(
      EXPECTED_ROUTING.respondSerializationSchema,
    );
    expect(record.requestNonce).toBe(0n);

    // Contract-fixed minimal calldata: placeholder selector + one fixed word.
    expect(calldata.is_some).toBe(true);
    expect(calldata.value.selector).toEqual(EXPECTED_SELECTOR);
    expect(calldata.value.noWords).toBe(1n);
    expect(calldata.value.words).toHaveLength(1);
    expect(calldata.value.words[0]).toEqual(EXPECTED_WORD);

    // The map key IS the domain-separated hash of the record — recomputed
    // off-chain with the library's TS twin of the request-id circuit.
    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));

    // Nonce bumped for the next request.
    expect(ledger(state).signetNonce).toBe(1n);
  });

  it("two identical submits mint DISTINCT request ids (nonce-keyed)", async () => {
    // Everything but the request nonce is a contract constant, so uniqueness
    // of the id rests entirely on signetNonce — pin that here.
    const { contract, ctx } = await deployContract();
    const afterFirst = (await contract.circuits.submitSignatureRequest(ctx, EVM_NONCE, KEY_VERSION)).context;
    const afterSecond = (
      await contract.circuits.submitSignatureRequest(afterFirst, EVM_NONCE, KEY_VERSION)
    ).context;

    const state = afterSecond.callContext.currentQueryContext.state;
    const index = toSignBidirectionalRequestIndex(ledger(state).signetRequestsIndex);
    expect(index.size).toBe(2);
    expect(ledger(state).signetNonce).toBe(2n);
  });

  it("rejects the legacy key version 0", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.submitSignatureRequest(ctx, EVM_NONCE, 0n),
    ).rejects.toThrow(/keyVersion must be >= 1/);
  });
});

// ---- Attestation fixtures ----

// An MPC key OTHER than the one the constructor pinned.
const IMPOSTER_KEYS = deriveJubjubKeypair(bytes(32, 0x43));

// A successful remote execution: first byte 1, rest zero; 32 meaningful
// bytes (one ABI word). The circuit never inspects the output's content —
// only the attestation over it — but this matches what the MPC posts.
const OUTPUT_SUCCESS = new Uint8Array(128);
OUTPUT_SUCCESS[0] = 1;

const OUTPUT_LEN = 32n;

/**
 * Sign a REAL attestation of (requestId, serializedOutput, outputLen) with
 * `keys` — message and challenge both come from the compiled circuits,
 * exactly like the MPC.
 */
const attest = (
  keys: JubjubKeypair,
  requestId: Uint8Array,
  serializedOutput: Uint8Array,
): RespondBidirectional => {
  const msg = signetCircuits.signetAttestationMessage(
    requestId,
    serializedOutput,
    OUTPUT_LEN,
  );
  const signature = schnorrSign(keys.sk, msg, (ax, ay, px, py, m) =>
    signetCircuits.schnorrChallenge(ax, ay, px, py, m),
  );
  return {
    serializedOutput,
    outputLen: OUTPUT_LEN,
    pk: keys.pk,
    announcement: signature.announcement,
    response: signature.response,
  };
};

// ---- Verify-response tests ----

describe("verifyResponse", () => {
  it("a genuine attestation verifies and consumes the request", async () => {
    const { contract, ctx, requestId } = await requestSubmitted();

    const next = (
      await contract.circuits.verifyResponse(
        ctx,
        requestId,
        attest(MPC_KEYS, requestId, OUTPUT_SUCCESS),
      )
    ).context;

    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.signetRequestsIndex.isEmpty()).toBe(true);
  });

  it("rejects an attestation by a key other than the pinned MPC key", async () => {
    const { contract, ctx, requestId } = await requestSubmitted();
    await expect(
      contract.circuits.verifyResponse(
        ctx,
        requestId,
        attest(IMPOSTER_KEYS, requestId, OUTPUT_SUCCESS),
      ),
    ).rejects.toThrow(/attestation pk is not the MPC key/);
  });

  it("rejects a tampered attestation (output differs from what was signed)", async () => {
    const { contract, ctx, requestId } = await requestSubmitted();
    const attestation = attest(MPC_KEYS, requestId, OUTPUT_SUCCESS);
    const tamperedOutput = new Uint8Array(128);
    tamperedOutput[0] = 2;
    await expect(
      contract.circuits.verifyResponse(ctx, requestId, {
        ...attestation,
        serializedOutput: tamperedOutput,
      }),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a genuine attestation presented under a different request id", async () => {
    const { contract, ctx, requestId } = await requestSubmitted();
    // Signed for some OTHER id: the message binds the request id, so the
    // signature cannot be replayed onto this pending request.
    const otherId = bytes(32, 0xab);
    await expect(
      contract.circuits.verifyResponse(
        ctx,
        requestId,
        attest(MPC_KEYS, otherId, OUTPUT_SUCCESS),
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a genuinely attested id that has no pending request", async () => {
    const { contract, ctx } = await requestSubmitted();
    const unknownId = bytes(32, 0xab);
    await expect(
      contract.circuits.verifyResponse(
        ctx,
        unknownId,
        attest(MPC_KEYS, unknownId, OUTPUT_SUCCESS),
      ),
    ).rejects.toThrow(/Request not found/);
  });

  it("a second verify of the SAME request rejects (the first consumed it)", async () => {
    const { contract, ctx, requestId } = await requestSubmitted();
    const next = (
      await contract.circuits.verifyResponse(
        ctx,
        requestId,
        attest(MPC_KEYS, requestId, OUTPUT_SUCCESS),
      )
    ).context;

    await expect(
      contract.circuits.verifyResponse(
        next,
        requestId,
        attest(MPC_KEYS, requestId, OUTPUT_SUCCESS),
      ),
    ).rejects.toThrow(/Request not found/);
  });
});
