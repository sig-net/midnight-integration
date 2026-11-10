// The facade refusals a fee-paying call can hit for lack of DUST, parsed for
// the amounts they name. Pure: no facade.

import { WalletError } from "@midnightntwrk/wallet-sdk-dust-wallet/v2";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { type DustShortfall, dustShortfall, isInsufficientDust } from "../src/index.ts";

describe("dustShortfall", () => {
  /** One thing a facade call may throw, and the shortfall read from it. */
  interface ThrownCase {
    readonly name: string;
    readonly thrown: unknown;
    readonly shortfall: DustShortfall | undefined;
  }

  const CASES: readonly ThrownCase[] = [
    {
      // The facade's verbatim refusal for a 2 NIGHT UTXO registered a minute after landing.
      name: "the facade's insufficient-generated-dust registration refusal",
      thrown: new Error(
        "Insufficient generated dust to cover registration fee (have 396816000000000, need 411384474481955). " +
          "Use WalletFacade.waitForGeneratedDust(utxos, 411384474481955) before retrying.",
      ),
      shortfall: { have: 396816000000000n, need: 411384474481955n },
    },
    {
      name: "the same refusal thrown as a string",
      thrown: "Insufficient generated dust to cover registration fee (have 1, need 2).",
      shortfall: { have: 1n, need: 2n },
    },
    {
      // The dust wallet's verbatim balancing refusal: it names no amount.
      name: "the balancing refusal",
      thrown: new Error(
        "Insufficient Funds: the configured coin selection declined the remaining 5 dust coin(s)",
      ),
      shortfall: undefined,
    },
    {
      name: "a node rejection",
      thrown: new Error("1010: Invalid Transaction: Custom error: 170"),
      shortfall: undefined,
    },
    { name: "something that is not an error", thrown: 42, shortfall: undefined },
  ];

  it.each(CASES)("reads $name", ({ thrown, shortfall }) => {
    expect(dustShortfall(thrown)).toEqual(shortfall);
  });
});

describe("isInsufficientDust", () => {
  const DUST_REFUSAL = new WalletError.InsufficientFundsError({
    message:
      "Insufficient Funds: the configured coin selection declined the remaining 5 dust coin(s)",
    tokenType: "dust",
  });
  const NIGHT_REFUSAL = new WalletError.InsufficientFundsError({
    message: "Insufficient funds",
    tokenType: "0000000000000000000000000000000000000000000000000000000000000000",
  });

  /** One thing a facade call may reject with, and whether it is a DUST refusal. */
  interface RejectionCase {
    readonly name: string;
    readonly rejection: () => Promise<unknown>;
    readonly expected: boolean;
  }

  const CASES: readonly RejectionCase[] = [
    {
      name: "the dust wallet's refusal inside Effect.runPromise's fiber wrapper",
      rejection: () =>
        Effect.runPromise(Effect.fail(DUST_REFUSAL)).catch((rejection: unknown) => rejection),
      expected: true,
    },
    {
      name: "the dust wallet's refusal thrown as itself",
      rejection: () => Promise.resolve(DUST_REFUSAL),
      expected: true,
    },
    {
      name: "an insufficient-funds refusal for another token",
      rejection: () =>
        Effect.runPromise(Effect.fail(NIGHT_REFUSAL)).catch((rejection: unknown) => rejection),
      expected: false,
    },
    {
      name: "a plain error carrying the dust wallet's wording",
      rejection: () => Promise.resolve(new Error(DUST_REFUSAL.message)),
      expected: false,
    },
    {
      name: "a defect inside the fiber wrapper",
      rejection: () =>
        Effect.runPromise(Effect.die(new Error("boom"))).catch((rejection: unknown) => rejection),
      expected: false,
    },
    {
      name: "something that is not an error",
      rejection: () => Promise.resolve(42),
      expected: false,
    },
  ];

  it.each(CASES)("reads $name as $expected", async ({ rejection, expected }) => {
    expect(isInsufficientDust(await rejection())).toBe(expected);
  });
});
