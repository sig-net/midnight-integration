// Simulator-level unit tests: the contract runs entirely in-process via
// @midnight-ntwrk/compact-runtime — no ledger, no network, no proving.

import { describe, expect, it } from "vitest";

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";

import {
  Contract,
  createVaultPrivateState,
  ledger,
  pureCircuits,
  witnesses,
  type VaultPrivateState,
} from "../src/index.ts";

// Dummy coin public key (32-byte hex). Required by the API, unused here.
const CPK = "0".repeat(64);

const deployContract = () => {
  const contract = new Contract<VaultPrivateState>(witnesses);
  const { currentContractState, currentPrivateState } = contract.initialState(
    createConstructorContext<VaultPrivateState>(createVaultPrivateState(), CPK),
  );
  const ctx = createCircuitContext(
    sampleContractAddress(),
    CPK,
    currentContractState,
    currentPrivateState,
  );
  return { contract, ctx };
};

describe("erc20-vault placeholder contract", () => {
  it("starts with an empty ledger", () => {
    const { ctx } = deployContract();

    const l = ledger(ctx.currentQueryContext.state);
    expect(l.round).toBe(0n);
    expect(l.secretHash).toEqual(new Uint8Array(32));
  });

  it("increment bumps the round counter", () => {
    const { contract, ctx } = deployContract();

    let next = ctx;
    next = contract.circuits.increment(next).context;
    next = contract.circuits.increment(next).context;

    expect(ledger(next.currentQueryContext.state).round).toBe(2n);
  });

  it("recordSecret stores the hash of the witness value", () => {
    const { contract, ctx } = deployContract();

    const next = contract.circuits.recordSecret(ctx).context;

    const l = ledger(next.currentQueryContext.state);
    expect(l.secretHash).toHaveLength(32);
    expect(l.secretHash).not.toEqual(new Uint8Array(32));
  });

  it("echo returns its input (pure circuit, no context needed)", () => {
    const input = new Uint8Array(32).fill(7);
    expect(pureCircuits.echo(input)).toEqual(input);
  });
});
