// How much NIGHT it takes to generate a given amount of DUST in a given time.

import type * as ledger from "@midnightntwrk/ledger-v9";

import { formatDust, formatNight } from "./format-amounts.ts";

/**
 * The NIGHT whose dust generation reaches `dust` within `seconds` of being
 * registered, starting from no DUST. One STAR generates
 * `generationDecayRate` SPECKs a second until it holds `nightDustRatio`
 * SPECKs, its cap.
 *
 * @param dust - The DUST to generate, in SPECKs.
 * @param seconds - The time the generation has, counted from registration.
 * @param rates - The ledger's dust generation rates.
 * @returns The NIGHT needed, in STARs, rounded up.
 * @throws {RangeError} If `seconds` is not positive.
 */
export function nightToGenerateDust(
  dust: bigint,
  seconds: bigint,
  rates: DustGenerationRates,
): bigint {
  if (seconds <= 0n) {
    throw new RangeError(`dust generation needs a positive time, got ${String(seconds)} s`);
  }
  const linear = rates.generationDecayRate * seconds;
  const specksPerStar = linear < rates.nightDustRatio ? linear : rates.nightDustRatio;
  return (dust + specksPerStar - 1n) / specksPerStar;
}

/** The rates of the ledger's dust parameters that set how fast NIGHT generates DUST and up to what cap. */
export type DustGenerationRates = Pick<
  ledger.DustParameters,
  "nightDustRatio" | "generationDecayRate"
>;

/** The generation times {@link formatNightToGenerateDust} prices a fee at. */
const GENERATION_HORIZONS: readonly { readonly label: string; readonly seconds: bigint }[] = [
  { label: "1 minute", seconds: 60n },
  { label: "10 minutes", seconds: 600n },
  { label: "1 hour", seconds: 3_600n },
  { label: "1 day", seconds: 86_400n },
];

/**
 * Tabulate the NIGHT that generates `dust` within each of a set of times
 * after registration, and at the generation cap, for the log lines under a
 * fee estimate.
 *
 * @param dust - The DUST to generate, in SPECKs.
 * @param rates - The ledger's dust generation rates.
 * @returns The table, as newline-joined lines in whole NIGHT and DUST.
 */
export function formatNightToGenerateDust(dust: bigint, rates: DustGenerationRates): string {
  const secondsToCap = rates.nightDustRatio / rates.generationDecayRate;
  const daysToCap = (secondsToCap + 43_200n) / 86_400n;
  return [
    `NIGHT that generates ${formatDust(dust)} DUST, counted from registering it with no DUST held:`,
    ...GENERATION_HORIZONS.map(
      ({ label, seconds }) =>
        `  within ${label}: ${formatNight(nightToGenerateDust(dust, seconds, rates))} NIGHT`,
    ),
    `  at the generation cap, reached after about ${String(daysToCap)} day(s): ` +
      `${formatNight(nightToGenerateDust(dust, secondsToCap + 1n, rates))} NIGHT`,
  ].join("\n");
}
