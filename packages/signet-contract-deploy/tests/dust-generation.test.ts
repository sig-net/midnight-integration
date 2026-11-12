// The NIGHT a DUST amount takes to generate, at the ledger's initial dust
// parameters. Pure: no network.

import * as ledger from "@midnightntwrk/ledger-v9";
import { describe, expect, it } from "vitest";

import { formatNightToGenerateDust, nightToGenerateDust } from "../src/plumbing/dust-generation.ts";

const RATES = { nightDustRatio: 5_000_000_000n, generationDecayRate: 8_267n };

describe("the ledger's initial dust parameters", () => {
  it("are the rates these cases are written against", () => {
    const { nightDustRatio, generationDecayRate } =
      ledger.LedgerParameters.initialParameters().dust;
    expect({ nightDustRatio, generationDecayRate }).toEqual(RATES);
  });
});

describe("nightToGenerateDust", () => {
  const cases: readonly { name: string; dust: bigint; seconds: bigint; stars: bigint }[] = [
    { name: "one STAR's second of generation", dust: 8_267n, seconds: 1n, stars: 1n },
    { name: "a SPECK more than that, rounded up", dust: 8_268n, seconds: 1n, stars: 2n },
    { name: "1 DUST in a minute", dust: 10n ** 15n, seconds: 60n, stars: 2_016_047_741n },
    { name: "1 DUST in a day", dust: 10n ** 15n, seconds: 86_400n, stars: 1_400_034n },
    { name: "1 DUST at the cap", dust: 10n ** 15n, seconds: 604_816n, stars: 200_000n },
    { name: "1 DUST long after the cap", dust: 10n ** 15n, seconds: 10n ** 9n, stars: 200_000n },
    { name: "no DUST", dust: 0n, seconds: 60n, stars: 0n },
  ];
  it.each(cases)("needs $stars STARs for $name", ({ dust, seconds, stars }) => {
    expect(nightToGenerateDust(dust, seconds, RATES)).toBe(stars);
  });

  it("refuses a time that is not positive", () => {
    expect(() => nightToGenerateDust(1n, 0n, RATES)).toThrow(RangeError);
  });
});

describe("formatNightToGenerateDust", () => {
  it("tabulates the NIGHT for each generation time and the cap", () => {
    expect(formatNightToGenerateDust(10n ** 15n, RATES)).toBe(
      [
        "NIGHT that generates 1 DUST, counted from registering it with no DUST held:",
        "  within 1 minute: 2016.047741 NIGHT",
        "  within 10 minutes: 201.604775 NIGHT",
        "  within 1 hour: 33.600796 NIGHT",
        "  within 1 day: 1.400034 NIGHT",
        "  at the generation cap, reached after about 7 day(s): 0.2 NIGHT",
      ].join("\n"),
    );
  });
});
