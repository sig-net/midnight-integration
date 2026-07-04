// Simulator-level unit tests: the contract runs entirely in-process via
// @midnight-ntwrk/compact-runtime — no ledger, no network, no proving.

import { describe, expect, it } from "vitest";

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";

import {
  readSignetEVMSignatureRequestIndexFromState,
  signetFieldNode,
  toSignetEVMSignatureRequestIndex,
  SIGNET_REQUESTS_INDEX_FIELD,
  type SignetEVMSignatureRequestLedgerIndex,
} from "@midnight-erc20-vault/signet-midnight";

import {
  Contract,
  createVaultPrivateState,
  ledger,
  witnesses,
  type VaultPrivateState,
} from "../src/index.ts";

// Dummy coin public key (32-byte hex). Required by the API, unused here.
const CPK = "0".repeat(64);

// Deterministic identity secret for the simulated caller.
const SECRET_KEY = new Uint8Array(32).fill(7);

// Deployer identity commitment pinned at deploy time (userCommitment of the
// deployer's secret key, computed off-chain in a real deploy). Tests here
// never call initialize(), so any 32 bytes work.
const DEPLOYER_COMMITMENT = new Uint8Array(32).fill(9);

const deployContract = () => {
  const contract = new Contract<VaultPrivateState>(witnesses);
  const { currentContractState, currentPrivateState } = contract.initialState(
    createConstructorContext<VaultPrivateState>(
      createVaultPrivateState(SECRET_KEY),
      CPK,
    ),
    DEPLOYER_COMMITMENT,
  );
  const ctx = createCircuitContext(
    sampleContractAddress(),
    CPK,
    currentContractState,
    currentPrivateState,
  );
  return { contract, ctx };
};

describe("erc20-vault contract", () => {
  it("signetRequestsIndex parses into the shared signet-midnight types", () => {
    const { ctx } = deployContract();

    // The assignment is the real assertion: the generated ledger type must
    // stay structurally identical to the shared library's named types.
    const ledgerIndex: SignetEVMSignatureRequestLedgerIndex = ledger(
      ctx.currentQueryContext.state,
    ).signetRequestsIndex;

    expect(ledgerIndex.isEmpty()).toBe(true);
    expect(toSignetEVMSignatureRequestIndex(ledgerIndex).size).toBe(0);
  });

  it("MPC-style: finds the request index in RAW state by position, no ledger()", () => {
    const { ctx } = deployContract();

    // What the MPC monitor does with only a contract address: take the raw
    // state (here from the simulator; in production from
    // queryContractState(address).data) and decode field 0 by the signet
    // convention — the compiled contract's ledger() is never used.
    const rawState = ctx.currentQueryContext.state;

    // Field 0 must be the request index map — the layout the contract's
    // "DO NOT DECLARE ANY OTHER LEDGER STATE ABOVE THIS LINE" comment pins.
    const node = signetFieldNode(rawState, SIGNET_REQUESTS_INDEX_FIELD);
    expect(node.type()).toBe("map");

    // And it must agree with the typed ledger() view of the same state.
    const rawIndex = readSignetEVMSignatureRequestIndexFromState(rawState);
    const typedIndex = toSignetEVMSignatureRequestIndex(
      ledger(ctx.currentQueryContext.state).signetRequestsIndex,
    );
    expect(rawIndex).toEqual(typedIndex);
    expect(rawIndex.size).toBe(0);
  });
});
