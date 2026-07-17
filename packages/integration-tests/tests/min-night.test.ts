// parseMinNight: MIN_DEPLOYER_NIGHT → bigint floor. Pure — no network.

import { describe, expect, it } from "vitest";

import { parseMinNight } from "../src/setup/steps.ts";

interface OkCase {
  name: string;
  raw: string | undefined;
  expected: bigint;
}

const OK_CASES: OkCase[] = [
  { name: "unset yields 0n", raw: undefined, expected: 0n },
  { name: "empty yields 0n", raw: "", expected: 0n },
  { name: "whitespace yields 0n", raw: "   ", expected: 0n },
  { name: "explicit zero yields 0n", raw: "0", expected: 0n },
  { name: "a plain integer parses", raw: "1000000", expected: 1_000_000n },
  { name: "surrounding whitespace is trimmed", raw: "  42 ", expected: 42n },
];

const THROW_CASES: { name: string; raw: string }[] = [
  { name: "non-numeric", raw: "abc" },
  { name: "negative", raw: "-5" },
  { name: "decimal", raw: "1.5" },
  { name: "underscored", raw: "1_000" },
];

describe("parseMinNight", () => {
  it.each(OK_CASES)("$name", ({ raw, expected }) => {
    expect(parseMinNight(raw)).toBe(expected);
  });

  it.each(THROW_CASES)("rejects $name", ({ raw }) => {
    expect(() => parseMinNight(raw)).toThrow(/MIN_DEPLOYER_NIGHT must be a non-negative integer/);
  });
});
