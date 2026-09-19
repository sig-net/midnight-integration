// Pure: fakes the slice of a ledger transaction the check reads.

import { describe, expect, it } from "vitest";

import {
  assertGuaranteedOnly,
  type CallSections,
  FallibleCallError,
  fallibleCalls,
  guaranteedOnlyProofProvider,
} from "../src/guaranteed-only.ts";

const call = (entryPoint: string, guaranteed: boolean, fallible: boolean) => ({
  address: "0xvault",
  entryPoint: new TextEncoder().encode(entryPoint),
  guaranteedTranscript: guaranteed ? {} : undefined,
  fallibleTranscript: fallible ? {} : undefined,
});

const tx = (...intents: [number, unknown[]][]): CallSections =>
  ({
    intents: new Map(intents.map(([id, actions]) => [id, { actions }])),
  }) as unknown as CallSections;

describe("fallibleCalls", () => {
  it("is empty for a wholly guaranteed call", () => {
    expect(fallibleCalls(tx([1, [call("startWithdraw", true, false)]]))).toEqual([]);
  });

  it("is empty for a transaction with no intents", () => {
    expect(fallibleCalls({ intents: undefined })).toEqual([]);
  });

  it("names a call demoted whole, and one split at a checkpoint", () => {
    const found = fallibleCalls(
      tx([1, [call("startSupply", false, true)]], [2, [call("startRedeem", true, true)]]),
    );
    expect(found).toEqual([
      { segment: 1, address: "0xvault", entryPoint: "startSupply", whole: true },
      { segment: 2, address: "0xvault", entryPoint: "startRedeem", whole: false },
    ]);
  });

  it("ignores actions that are not calls", () => {
    expect(fallibleCalls(tx([1, [{ verifierKey: "deploy" }]]))).toEqual([]);
  });
});

describe("assertGuaranteedOnly", () => {
  it("throws a FallibleCallError naming the call", () => {
    const demoted = tx([1, [call("startSupply", false, true)]]);
    expect(() => {
      assertGuaranteedOnly(demoted);
    }).toThrow(FallibleCallError);
    expect(() => {
      assertGuaranteedOnly(demoted);
    }).toThrow("startSupply on 0xvault (segment 1, whole)");
  });
});

describe("guaranteedOnlyProofProvider", () => {
  it("refuses before the base provider is reached", async () => {
    let proved = 0;
    const provider = guaranteedOnlyProofProvider({
      proveTx: (t) => {
        proved += 1;
        return Promise.resolve(t as never);
      },
    });
    await expect(
      provider.proveTx(tx([1, [call("startSupply", false, true)]]) as never),
    ).rejects.toThrow(FallibleCallError);
    expect(proved).toBe(0);
    await provider.proveTx(tx([1, [call("startWithdraw", true, false)]]) as never);
    expect(proved).toBe(1);
  });
});
