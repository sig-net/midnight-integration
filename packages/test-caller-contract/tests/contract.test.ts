// Simulator-level unit tests: the contract runs entirely in-process via
// @midnight-ntwrk/compact-runtime — no ledger, no network, no proving.

import { describe, expect, it } from "vitest";

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";

import {
  MPCDestination,
  MPCSignatureAlgorithm,
  TxParamType,
  asciiPadded,
  bigintToBytes32,
  calculateRequestId,
  readSignetRequestsLedgerFromState,
  requestIdBytes,
  requestIdHex,
  secp256k1PublicKeyOf,
  signAttestationDigest,
  signetFieldNode,
  toSignBidirectionalEventIndex,
  type RespondBidirectionalEvent,
  type SignBidirectionalEventLedgerMap,
  calculateSignetAttestationDigest,
} from "@sig-net/midnight";

import { Contract, ledger, pureCircuits as callerCircuits, witnesses, type CallerPrivateState } from "../src/index.ts";
import { createCallerPrivateState } from "../src/witnesses.ts";
// The signet contract (callee) module — the same one the caller's generated
// code cross-contract-calls. submitSignatureRequest ends in a call to its
// signBidirectionalEvent, so the simulator needs its state (see
// signetStateProvider) to execute that path.
import * as SignetSigner from "../src/managed/SignetSigner/contract/index.js";

// ---- Fixtures ----

// THIS contract's ledger layout (declaration order in test-caller-contract.compact):
// requestLog List at field 0, counter at field 1, request map at field 4.
// The map position must match the `4 as Uint<8>` requestsIndexField the
// contract passes in submitSignatureRequest's notification.
const REQUEST_LOG_FIELD = 0;
const NONCE_FIELD = 1;
const REQUESTS_INDEX_FIELD = 4;

// Dummy coin public key (32-byte hex). Required by the API, unused here.
const CPK = "0".repeat(64);

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

// The "MPC" of these tests: its response key (secp256k1, derived per client
// contract from the contract address + the fixed path "midnight response
// key") is pinned by the one-shot initialise circuit right after deploy,
// exactly as a real deployment pins the off-chain-derived key (the key
// depends on the contract's own address, so it cannot be a constructor arg).
const MPC_RESPONSE_SECRET = bytes(32, 0x42);
const MPC_RESPONSE_KEY = secp256k1PublicKeyOf(MPC_RESPONSE_SECRET);

// The deployer's identity secret: its commitment is sealed by the
// constructor and gates initialise (answered by the deployerSecretKey
// witness from private state).
const DEPLOYER_SECRET = bytes(32, 0xd0);

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
 * signBidirectionalEvent in-process (no node/indexer). Returns the state for
 * any address: the caller only calls the single sealed signet contract.
 */
const signetStateProvider = async () => {
  const signet = new SignetSigner.Contract({});
  const { currentContractState } = await signet.initialState(
    createConstructorContext(undefined, CPK),
  );
  return { getContractState: async () => currentContractState };
};

// The simulated caller's own contract address; kernel.self() inside the
// circuits — and therefore the request's sender field.
const CALLER_ADDRESS = sampleContractAddress();
const CALLER_ADDRESS_BYTES = Uint8Array.from(Buffer.from(CALLER_ADDRESS, "hex"));

// The contract-fixed request constants (mirrors of the in-circuit literals in
// test-caller-contract.compact; the round-trip test below is the lockstep check).
const EXPECTED_TO = asciiPadded("signet-caller-e2e-to", 20);
const EXPECTED_SELECTOR = new Uint8Array([0xca, 0x11, 0xab, 0x1e]);
const EXPECTED_WORD = asciiPadded("signet-caller:fixed-word", 32);
const EXPECTED_CAIP2 = asciiPadded("eip155:31337", 32);
const EXPECTED_PATH = asciiPadded("caller-path", 32);
// Schemas are EXACT-width by protocol convention (never NUL-padded: the
// MPC's raw reader recovers the width from the stored bytes). One request
// map per schema width: field 4 carries the 34-byte bool schema, field 7
// the 69-byte bool+uint256 schema.
const EXPECTED_SCHEMA = asciiPadded('[{"name":"success","type":"bool"}]', 34);
const EXPECTED_SCHEMA_BOOL_UINT = asciiPadded(
  '[{"name":"success","type":"bool"},{"name":"amount","type":"uint256"}]',
  69,
);

// The caller-supplied circuit args of a valid submit.
const EVM_NONCE = 7n;
const KEY_VERSION = 1n;

// Real-EVM submit fixtures: a target contract address (any 20 bytes at the
// simulator level) and one big-endian ABI word argument (uint256 6).
const EVM_TARGET_TO = bytes(20, 0x77);
const ARG_WORD = (() => {
  const word = new Uint8Array(32);
  word[31] = 6;
  return word;
})();

// The in-circuit selector literals: first 4 bytes of keccak256 of the
// Solidity signatures, pinned here and re-derived from ethers in the e2e.
const SELECTOR_IS_EVEN = new Uint8Array([0x2a, 0x2e, 0x13, 0x20]); // isEven(uint256)
const SELECTOR_CHECK_AND_DOUBLE = new Uint8Array([0xe6, 0xcf, 0x21, 0x87]); // checkAndDouble(uint256)

// ---- Harness ----

/**
 * Deploy WITHOUT pinning the response key — the pre-initialise state. The
 * constructor seals the DEPLOYER_SECRET's commitment; `witnessSecret` is
 * what the private state answers the deployerSecretKey witness with (pass an
 * imposter's secret to exercise the initialise gate).
 */
const deployUninitialised = async (witnessSecret: Uint8Array = DEPLOYER_SECRET) => {
  const contract = new Contract<CallerPrivateState>(witnesses);
  const { currentContractState, currentPrivateState } =
    await contract.initialState(
      createConstructorContext<CallerPrivateState>(createCallerPrivateState(witnessSecret), CPK),
      callerCircuits.deployerCommitment(DEPLOYER_SECRET),
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

/** Deploy + initialise(MPC_RESPONSE_KEY): the ready-to-use contract. */
const deployContract = async () => {
  const { contract, ctx } = await deployUninitialised();
  const next = (await contract.circuits.initialise(ctx, MPC_RESPONSE_KEY)).context;
  return { contract, ctx: next };
};

/**
 * Deploy + submitSignatureRequest(EVM_NONCE, KEY_VERSION): the arrange step
 * of every verifyResponse test. Returns the pending request's id (the single
 * ledger map key) alongside the threaded context.
 */
const requestSubmitted = async () => {
  const { contract, ctx } = await deployContract();
  const next = (await contract.circuits.submitSignatureRequest(ctx, EVM_NONCE, KEY_VERSION)).context;
  const index = toSignBidirectionalEventIndex(
    ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap,
  );
  const [idHex] = [...index.keys()];
  return { contract, ctx: next, requestId: requestIdBytes(idHex) };
};

// ---- Tests ----

describe("initialise", () => {
  it("stores the MPC response key verbatim (uninitialised before, the point after)", async () => {
    const { contract, ctx } = await deployUninitialised();
    expect(ledger(ctx.callContext.currentQueryContext.state).initialised).toBe(0n);

    const next = (await contract.circuits.initialise(ctx, MPC_RESPONSE_KEY)).context;
    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.initialised).toBe(1n);
    expect(state.mpcResponseKey).toEqual(MPC_RESPONSE_KEY);
  });

  it("is set-once: a second initialise rejects", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.initialise(ctx, IMPOSTER_PUBLIC),
    ).rejects.toThrow(/Already initialised/);
  });

  it("is deployer-gated: a witness secret other than the sealed commitment's rejects", async () => {
    const { contract, ctx } = await deployUninitialised(bytes(32, 0xba));
    await expect(
      contract.circuits.initialise(ctx, MPC_RESPONSE_KEY),
    ).rejects.toThrow(/Not the deployer/);
  });
});

describe("test-caller-contract ledger shape", () => {
  it("signBidirectionalEventMap parses into the shared signet-midnight types", async () => {
    const { ctx } = await deployContract();

    // The assignment is the real assertion: the generated ledger type must
    // stay structurally identical to the shared library's named types.
    const ledgerMap: SignBidirectionalEventLedgerMap = ledger(
      ctx.callContext.currentQueryContext.state,
    ).signBidirectionalEventMap;

    expect(ledgerMap.isEmpty()).toBe(true);
    expect(toSignBidirectionalEventIndex(ledgerMap).size).toBe(0);
  });

  it("MPC-style: finds the request map in RAW state by position, no ledger()", async () => {
    const { ctx } = await deployContract();

    const rawState = ctx.callContext.currentQueryContext.state;
    // The List at field 0 is array-typed exactly like a chunked field root;
    // resolving the map behind it is the point of this layout.
    expect(signetFieldNode(rawState, REQUEST_LOG_FIELD).type()).toBe("array");
    const node = signetFieldNode(rawState, REQUESTS_INDEX_FIELD);
    expect(node.type()).toBe("map");

    const { nonce, requestsIndex } = readSignetRequestsLedgerFromState(
      rawState,
      REQUESTS_INDEX_FIELD,
      NONCE_FIELD,
    );
    const typedIndex = toSignBidirectionalEventIndex(
      ledger(ctx.callContext.currentQueryContext.state).signBidirectionalEventMap,
    );
    expect(requestsIndex).toEqual(typedIndex);
    expect(requestsIndex.size).toBe(0);
    expect(nonce).toBe(0n);
  });
});

describe("submitSignatureRequest round-trip", () => {
  it("stores a fully contract-composed request readable identically via ledger(), the shared parser, and the RAW reader", async () => {
    const { contract, ctx } = await deployContract();

    const { result, context: next } = await contract.circuits.submitSignatureRequest(
      ctx,
      EVM_NONCE,
      KEY_VERSION,
    );
    const state = next.callContext.currentQueryContext.state;

    // Read 1: generated ledger().
    const typedIndex = toSignBidirectionalEventIndex(
      ledger(state).signBidirectionalEventMap,
    );
    // Read 2: MPC-style raw read — no compiled contract involved.
    const rawLedger = readSignetRequestsLedgerFromState(
      state,
      REQUESTS_INDEX_FIELD,
      NONCE_FIELD,
    );

    expect(typedIndex.size).toBe(1);
    expect(rawLedger.requestsIndex).toEqual(typedIndex);
    expect(rawLedger.nonce).toBe(ledger(state).signetRequestNonce);

    const [idHex, record] = [...typedIndex.entries()][0];

    // The cross-contract call's return value: the notification landed under
    // (requestId, 0) in the signet contract's registry.
    expect(result).toEqual({ count: 0n, requestId: requestIdBytes(idHex) });

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
    // escaped JSON schema and the sender = kernel.self()).
    expect(record.sender).toEqual({ bytes: CALLER_ADDRESS_BYTES });
    expect(record.requestNonce).toBe(0n);
    expect(record.keyVersion).toBe(KEY_VERSION);
    expect(record.path).toEqual(EXPECTED_PATH);
    expect(record.algo).toBe(MPCSignatureAlgorithm.ecdsa);
    expect(record.dest).toBe(MPCDestination.unused);
    expect(record.params).toEqual(new Uint8Array(64));
    expect(record.txParamType).toBe(TxParamType.evmType2);
    expect(record.caip2Id).toEqual(EXPECTED_CAIP2);
    expect(record.outputDeserializationSchema).toEqual(EXPECTED_SCHEMA);
    expect(record.respondSerializationSchema).toEqual(EXPECTED_SCHEMA);

    // Contract-fixed minimal calldata: placeholder selector + one fixed word.
    expect(calldata.is_some).toBe(true);
    expect(calldata.value.selector).toEqual(EXPECTED_SELECTOR);
    expect(calldata.value.noWords).toBe(1n);
    expect(calldata.value.words).toHaveLength(1);
    expect(calldata.value.words[0]).toEqual(EXPECTED_WORD);

    // The map key IS the persistent hash of the record — recomputed
    // off-chain with the library's TS twin of the request-id circuit.
    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));

    // Nonce bumped for the next request.
    expect(ledger(state).signetRequestNonce).toBe(1n);
  });

  it("two identical submits mint DISTINCT request ids (nonce-keyed)", async () => {
    // Everything but the request nonce is a contract constant, so uniqueness
    // of the id rests entirely on signetRequestNonce — pin that here.
    const { contract, ctx } = await deployContract();
    const afterFirst = (await contract.circuits.submitSignatureRequest(ctx, EVM_NONCE, KEY_VERSION)).context;
    const afterSecond = (
      await contract.circuits.submitSignatureRequest(afterFirst, EVM_NONCE, KEY_VERSION)
    ).context;

    const state = afterSecond.callContext.currentQueryContext.state;
    const index = toSignBidirectionalEventIndex(ledger(state).signBidirectionalEventMap);
    expect(index.size).toBe(2);
    expect(ledger(state).signetRequestNonce).toBe(2n);
  });

  it("rejects the legacy key version 0", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.submitSignatureRequest(ctx, EVM_NONCE, 0n),
    ).rejects.toThrow(/keyVersion must be >= 1/);
  });
});

describe("EVM target submit circuits round-trip", () => {
  // Per-circuit lockstep expectations: the selector and schema literals the
  // contract fixes for each SignetEvmTarget method, plus which per-width
  // request map the request lands in.
  const CASES = [
    {
      name: "submitIsEvenRequest",
      submit: "submitIsEvenRequest" as const,
      selector: SELECTOR_IS_EVEN,
      schema: EXPECTED_SCHEMA,
      map: "signBidirectionalEventMap" as const,
    },
    {
      name: "submitCheckAndDoubleRequest",
      submit: "submitCheckAndDoubleRequest" as const,
      selector: SELECTOR_CHECK_AND_DOUBLE,
      schema: EXPECTED_SCHEMA_BOOL_UINT,
      map: "signBidirectionalEventMap69" as const,
    },
  ];

  it.each(CASES)("$name stores the caller-supplied target and word inside the fixed envelope", async ({ submit, selector, schema, map }) => {
    const { contract, ctx } = await deployContract();

    const next = (
      await contract.circuits[submit](ctx, EVM_NONCE, KEY_VERSION, EVM_TARGET_TO, ARG_WORD)
    ).context;
    const state = next.callContext.currentQueryContext.state;

    const typedIndex = toSignBidirectionalEventIndex(ledger(state)[map]);
    expect(typedIndex.size).toBe(1);
    const [idHex, record] = [...typedIndex.entries()][0];

    // Caller-supplied fields land verbatim; the rest is the same fixed
    // envelope as submitSignatureRequest.
    const { calldata, ...envelope } = record.txParams;
    expect(envelope).toEqual({
      to: EVM_TARGET_TO,
      chainId: 31337n,
      nonce: EVM_NONCE,
      gasLimit: 100000n,
      maxFeePerGas: 30000000000n,
      maxPriorityFeePerGas: 1000000000n,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
    });
    expect(record.path).toEqual(EXPECTED_PATH);
    expect(record.caip2Id).toEqual(EXPECTED_CAIP2);
    expect(record.outputDeserializationSchema).toEqual(schema);
    expect(record.respondSerializationSchema).toEqual(schema);

    expect(calldata.is_some).toBe(true);
    expect(calldata.value.selector).toEqual(selector);
    expect(calldata.value.noWords).toBe(1n);
    expect(calldata.value.words[0]).toEqual(ARG_WORD);

    // Map key = the request-id TS twin, same as the base circuit.
    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));
  });

  it("all three submit circuits share the nonce counter and mint distinct ids", async () => {
    const { contract, ctx } = await deployContract();
    const afterFirst = (await contract.circuits.submitSignatureRequest(ctx, EVM_NONCE, KEY_VERSION)).context;
    const afterSecond = (
      await contract.circuits.submitIsEvenRequest(afterFirst, EVM_NONCE, KEY_VERSION, EVM_TARGET_TO, ARG_WORD)
    ).context;
    const afterThird = (
      await contract.circuits.submitCheckAndDoubleRequest(afterSecond, EVM_NONCE, KEY_VERSION, EVM_TARGET_TO, ARG_WORD)
    ).context;

    const state = afterThird.callContext.currentQueryContext.state;
    // Bool-schema requests share field 4, the 69-byte schema lives at field 7.
    expect(toSignBidirectionalEventIndex(ledger(state).signBidirectionalEventMap).size).toBe(2);
    expect(toSignBidirectionalEventIndex(ledger(state).signBidirectionalEventMap69).size).toBe(1);
    expect(ledger(state).signetRequestNonce).toBe(3n);
  });
});

// ---- Response fixtures ----

// An MPC key OTHER than the one the constructor pinned.
const IMPOSTER_SECRET = bytes(32, 0x43);
const IMPOSTER_PUBLIC = secp256k1PublicKeyOf(IMPOSTER_SECRET);

// A successful remote execution's serialised output: this contract's respond
// schema is a single bool, whose exact unpadded packed payload is ONE byte
// (0x01 = true). The circuit never inspects the output's content — only the
// digest and signature over it — but this matches what the MPC posts.
const OUTPUT_SUCCESS = Uint8Array.from([1]);

/**
 * Sign a REAL respond-bidirectional response for (requestId, output) with
 * `secretKey` — the digest comes from the TS twin (pinned against the
 * compiled oracle circuits), exactly like the MPC. Signature scalars land as
 * LE bytes, the ledger form.
 */
const respond = (
  secretKey: Uint8Array,
  requestId: Uint8Array,
  serializedOutput: Uint8Array,
): RespondBidirectionalEvent => {
  const attestationDigest = calculateSignetAttestationDigest(
    requestId,
    serializedOutput,
  );
  const sig = signAttestationDigest(attestationDigest, secretKey);
  return {
    attestationDigest,
    r: bigintToBytes32(sig.r),
    s: bigintToBytes32(sig.s),
    recoveryId: BigInt(sig.recoveryId),
  };
};

// ---- Verify-response tests ----

describe("verifyResponse", () => {
  it("rejects while uninitialised (no stored key yet)", async () => {
    const { contract, ctx } = await deployUninitialised();
    const next = (await contract.circuits.submitSignatureRequest(ctx, EVM_NONCE, KEY_VERSION)).context;
    const index = toSignBidirectionalEventIndex(
      ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap,
    );
    const [idHex] = [...index.keys()];
    const requestId = requestIdBytes(idHex);
    await expect(
      contract.circuits.verifyResponse(
        next,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS),
        OUTPUT_SUCCESS,
      ),
    ).rejects.toThrow(/Not initialised/);
  });

  it("a genuine response verifies and consumes the request", async () => {
    const { contract, ctx, requestId } = await requestSubmitted();

    const next = (
      await contract.circuits.verifyResponse(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS),
        OUTPUT_SUCCESS,
      )
    ).context;

    const state = ledger(next.callContext.currentQueryContext.state);
    expect(state.signBidirectionalEventMap.isEmpty()).toBe(true);
  });

  it("rejects an imposter's signature (verified against the STORED key)", async () => {
    const { contract, ctx, requestId } = await requestSubmitted();
    await expect(
      contract.circuits.verifyResponse(
        ctx,
        requestId,
        respond(IMPOSTER_SECRET, requestId, OUTPUT_SUCCESS),
        OUTPUT_SUCCESS,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a tampered response (output differs from what was signed)", async () => {
    const { contract, ctx, requestId } = await requestSubmitted();
    const response = respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS);
    const tamperedOutput = Uint8Array.from([0]);
    await expect(
      contract.circuits.verifyResponse(
        ctx,
        requestId,
        response,
        tamperedOutput,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a tampered digest checkpoint (signature untouched)", async () => {
    const { contract, ctx, requestId } = await requestSubmitted();
    const response = respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS);
    await expect(
      contract.circuits.verifyResponse(
        ctx,
        requestId,
        { ...response, attestationDigest: bytes(32, 0x99) },
        OUTPUT_SUCCESS,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a genuine response presented under a different request id", async () => {
    const { contract, ctx, requestId } = await requestSubmitted();
    // Signed for some OTHER id: the digest binds the request id, so the
    // signature cannot be replayed onto this pending request.
    const otherId = bytes(32, 0xab);
    await expect(
      contract.circuits.verifyResponse(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, otherId, OUTPUT_SUCCESS),
        OUTPUT_SUCCESS,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a genuinely signed id that has no pending request", async () => {
    const { contract, ctx } = await requestSubmitted();
    const unknownId = bytes(32, 0xab);
    await expect(
      contract.circuits.verifyResponse(
        ctx,
        unknownId,
        respond(MPC_RESPONSE_SECRET, unknownId, OUTPUT_SUCCESS),
        OUTPUT_SUCCESS,
      ),
    ).rejects.toThrow(/Request not found/);
  });

  it("a second verify of the SAME request rejects (the first consumed it)", async () => {
    const { contract, ctx, requestId } = await requestSubmitted();
    const next = (
      await contract.circuits.verifyResponse(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS),
        OUTPUT_SUCCESS,
      )
    ).context;

    await expect(
      contract.circuits.verifyResponse(
        next,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS),
        OUTPUT_SUCCESS,
      ),
    ).rejects.toThrow(/Request not found/);
  });
});

describe("verifyCheckAndDoubleResponse", () => {
  // A successful checkAndDouble execution's packed respond payload: bool
  // true (1 byte) followed by uint256 12 as a 32-byte little-endian Field.
  const OUTPUT_BOOL_UINT = (() => {
    const out = new Uint8Array(33);
    out[0] = 1;
    out[1] = 12;
    return out;
  })();

  /** Deploy + submitCheckAndDoubleRequest: the arrange step. */
  const checkAndDoubleSubmitted = async () => {
    const { contract, ctx } = await deployContract();
    const next = (
      await contract.circuits.submitCheckAndDoubleRequest(ctx, EVM_NONCE, KEY_VERSION, EVM_TARGET_TO, ARG_WORD)
    ).context;
    const index = toSignBidirectionalEventIndex(
      ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap69,
    );
    const [idHex] = [...index.keys()];
    return { contract, ctx: next, requestId: requestIdBytes(idHex) };
  };

  it("a genuine 33-byte response verifies and consumes the request", async () => {
    const { contract, ctx, requestId } = await checkAndDoubleSubmitted();
    const next = (
      await contract.circuits.verifyCheckAndDoubleResponse(
        ctx,
        requestId,
        respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_BOOL_UINT),
        OUTPUT_BOOL_UINT,
      )
    ).context;
    expect(
      ledger(next.callContext.currentQueryContext.state).signBidirectionalEventMap69.isEmpty(),
    ).toBe(true);
  });

  it("rejects when the presented output differs from what was signed", async () => {
    const { contract, ctx, requestId } = await checkAndDoubleSubmitted();
    const response = respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_BOOL_UINT);
    const tampered = Uint8Array.from(OUTPUT_BOOL_UINT);
    tampered[1] = 13;
    await expect(
      contract.circuits.verifyCheckAndDoubleResponse(ctx, requestId, response, tampered),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects a cross-width replay: a 1-byte-output attestation cannot verify at width 33", async () => {
    // The digest hashes the output at its exact length, so an attestation
    // over the 1-byte bool payload can never match a 33-byte presentation,
    // even with the honest first byte and zero padding.
    const { contract, ctx, requestId } = await checkAndDoubleSubmitted();
    const boolOnlyResponse = respond(MPC_RESPONSE_SECRET, requestId, OUTPUT_SUCCESS);
    const paddedOutput = new Uint8Array(33);
    paddedOutput[0] = OUTPUT_SUCCESS[0]!;
    await expect(
      contract.circuits.verifyCheckAndDoubleResponse(ctx, requestId, boolOnlyResponse, paddedOutput),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("rejects an imposter's signature", async () => {
    const { contract, ctx, requestId } = await checkAndDoubleSubmitted();
    await expect(
      contract.circuits.verifyCheckAndDoubleResponse(
        ctx,
        requestId,
        respond(IMPOSTER_SECRET, requestId, OUTPUT_BOOL_UINT),
        OUTPUT_BOOL_UINT,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });
});
