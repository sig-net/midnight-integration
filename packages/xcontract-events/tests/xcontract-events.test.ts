// Simulator-level confirmation that THIS repo's toolchain (compactc 0.33 /
// compact-runtime 0.18 / ledger-9) supports the two v5 features:
//
//   1. Custom events — token.compact emits a MIP-0002 `Misc` event whose
//      payload is a serialized custom struct carrying the deposit data.
//   2. Cross-contract — vault.compact calls token.deposit; the `amount`
//      flows A → B → into B's emitted event.
//
// Everything runs in-process via @midnight-ntwrk/compact-runtime — no node, no
// indexer, no proving. Note the reach limits of a pure simulator:
//   • An emitted event is written into the circuit's public transcript, which
//     lives behind an opaque WASM handle here — event *delivery* is only
//     observable on a live node via the indexer's event stream. So we prove the
//     custom payload ROUND-TRIPS (encode in-circuit → decode in TS), that the
//     emit path RUNS (ledger mutates), and that it COMPILED to an event (`log`)
//     op carrying the serialized payload.
//   • A real cross-contract call resolves the callee's on-chain state via the
//     public data provider; in-process we assert the compiler wired the
//     reference (contractReferenceLocations), lowered the call
//     (crossContractCall) passing the arg through, and that the callee address
//     is extractable exactly as the SDK extracts it before assembling the tx.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  contractDependencies,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";

import * as Token from "../src/managed/Token/contract/index.js";
import * as Vault from "../src/managed/vault/contract/index.js";

// Dummy coin public key (32-byte hex). Required by the API, unused here.
const CPK = "0".repeat(64);

const managed = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../src/managed/${rel}`, import.meta.url)), "utf8");

// A sample caller address in the { bytes } shape the contract uses.
const sampleCaller = (): { bytes: Uint8Array } => ({
  bytes: Uint8Array.from(Buffer.from(sampleContractAddress(), "hex")),
});

describe("custom event (MIP-0002 Misc + serialized struct) — token.compact", () => {
  it("the pure event-hash circuit is deterministic and depends on every field", () => {
    // depositEventHash is what an off-chain verifier recomputes from an event's
    // fields to check set membership. It must be a pure function of its inputs.
    const caller = sampleCaller();
    const h1 = Token.pureCircuits.depositEventHash(4242n, 0n, caller);
    const h2 = Token.pureCircuits.depositEventHash(4242n, 0n, caller);
    expect(h1).toHaveLength(32);
    expect(Buffer.from(h1).toString("hex")).toBe(Buffer.from(h2).toString("hex"));
    // Changing any field changes the hash.
    expect(Buffer.from(Token.pureCircuits.depositEventHash(9999n, 0n, caller)).toString("hex"))
      .not.toBe(Buffer.from(h1).toString("hex"));
    expect(Buffer.from(Token.pureCircuits.depositEventHash(4242n, 1n, caller)).toString("hex"))
      .not.toBe(Buffer.from(h1).toString("hex"));
    expect(Buffer.from(Token.pureCircuits.depositEventHash(4242n, 0n, sampleCaller())).toString("hex"))
      .not.toBe(Buffer.from(h1).toString("hex"));
  });

  it("runs the emit path, mutates ledger state, and records the event hash (authenticated emission)", async () => {
    const token = new Token.Contract({});
    const { currentContractState, currentPrivateState } = await token.initialState(
      createConstructorContext(undefined, CPK),
    );
    const ctx = createCircuitContext(
      "deposit",
      sampleContractAddress(),
      CPK,
      currentContractState,
      currentPrivateState,
    );

    // Executing deposit runs the `emit (Misc { ... serialize(...) })` statement
    // and returns the event hash; a throw here would mean the path failed.
    const caller = sampleCaller();
    const { result, context } = await token.circuits.deposit(ctx, 4242n, caller);

    const led = Token.ledger(context.callContext.currentQueryContext.state);
    expect(led.depositCount).toBe(1n);
    expect(led.lastAmount).toBe(4242n);

    // The returned hash equals the pure recomputation (sequence 0 = first deposit),
    // and is recorded in the authenticated emittedDeposits set.
    const expectedHash = Token.pureCircuits.depositEventHash(4242n, 0n, caller);
    expect(Buffer.from(result).toString("hex")).toBe(Buffer.from(expectedHash).toString("hex"));
    expect(led.emittedDeposits.member(expectedHash)).toBe(true);
  });

  it("compiled emit → a `log` transcript op over the serialized payload", () => {
    const js = managed("Token/contract/index.js");
    expect(js).toContain("'log'");
  });
});

describe("cross-contract call — vault.depositViaVault → token.deposit", () => {
  it("passes the arg through: vault lowers to crossContractCall('deposit', ...amount)", () => {
    // The `amount` that arrives at the vault is forwarded into the callee's
    // deposit — this is the data that ends up in B's event.
    const js = managed("vault/contract/index.js");
    expect(js).toContain("crossContractCall");
    expect(js).toContain("'deposit'");
    expect(js).toContain("amount_0"); // the forwarded argument
  });

  it("wires the callee reference so its address is extractable (as the SDK does)", async () => {
    const tokenHex = sampleContractAddress();
    const tokenRef = { bytes: Uint8Array.from(Buffer.from(tokenHex, "hex")) };

    const vault = new Vault.Contract({});
    const { currentContractState } = await vault.initialState(
      createConstructorContext(undefined, CPK),
      tokenRef,
    );

    // Exactly the resolution the runtime performs before assembling a
    // multi-contract transaction: read the root contract's state, pull out the
    // addresses of every contract it depends on, fetch their states.
    const deps = contractDependencies(
      Vault.contractReferenceLocations,
      currentContractState.data.state,
    );
    expect(deps).toEqual([tokenHex]);
  });

  it("marks the reference ledger cell as a contractAddress", () => {
    expect(JSON.stringify(Vault.contractReferenceLocations)).toContain("contractAddress");
  });
});
