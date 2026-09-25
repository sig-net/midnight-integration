import { describe, expect, it } from "vitest";

import { assertCompilationIdentity, fixtureIdentity } from "../src/toolchain.ts";

describe("compiler identity", () => {
  it("accepts the current fixture", () => {
    const identity = fixtureIdentity();
    expect(() => {
      assertCompilationIdentity(identity, identity.fixtureSha256, identity.outputSha256);
    }).not.toThrow();
  });
  it.each([
    "release",
    "build",
    "runtime",
    "compilerSha256",
    "fixtureSha256",
    "outputSha256",
  ] as const)("rejects a mutated %s", (key) => {
    const identity = fixtureIdentity();
    expect(() => {
      assertCompilationIdentity(
        { ...identity, [key]: "mutated" },
        identity.fixtureSha256,
        identity.outputSha256,
      );
    }).toThrow("identity mismatch");
  });
});
