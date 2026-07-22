// Unit tests for the cross-contract proof-server provider factory. Proving
// itself needs a running proof server, so the check/prove/lookupKey legs are
// covered by the integration suite; these cover the offline construction
// contract.

import {
  ZKConfigProvider,
  createProverKey,
  createVerifierKey,
  createZKIR,
  type ProverKey,
  type VerifierKey,
  type ZKIR,
} from "@midnight-ntwrk/midnight-js/types";
import { describe, expect, it } from "vitest";

import { createCrossContractProofServerProvider } from "../src/index.ts";

const PROOF_SERVER_URL = "http://127.0.0.1:6300";

/** Serves fixed in-memory key material (enough for construction-time wiring). */
class StaticZKConfigProvider extends ZKConfigProvider<string> {
  getZKIR(): Promise<ZKIR> {
    return Promise.resolve(createZKIR(new Uint8Array([1])));
  }
  getProverKey(): Promise<ProverKey> {
    return Promise.resolve(createProverKey(new Uint8Array([2])));
  }
  getVerifierKey(): Promise<VerifierKey> {
    return Promise.resolve(createVerifierKey(new Uint8Array([3])));
  }
}

describe("createCrossContractProofServerProvider", () => {
  it("throws when no zk-config providers are given", () => {
    expect(() => createCrossContractProofServerProvider(PROOF_SERVER_URL, [])).toThrow(
      "at least one zkConfigProvider is required",
    );
  });

  it("builds a proof provider from a non-empty provider set", () => {
    const proofProvider = createCrossContractProofServerProvider(PROOF_SERVER_URL, [
      new StaticZKConfigProvider(),
    ]);
    expect(typeof proofProvider.proveTx).toBe("function");
  });
});
