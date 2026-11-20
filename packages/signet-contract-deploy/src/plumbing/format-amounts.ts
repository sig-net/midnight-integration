/**
 * Format STARs as NIGHT with all 6 decimal places preserved when significant.
 *
 * @param stars - The amount in atomic NIGHT units.
 * @returns The decimal NIGHT amount, without a unit suffix.
 */
export function formatNight(stars: bigint): string {
  return formatDecimal(stars, 6);
}

/**
 * Format SPECKs as DUST with all 15 decimal places preserved when significant.
 *
 * @param specks - The amount in atomic DUST units.
 * @returns The decimal DUST amount, without a unit suffix.
 */
export function formatDust(specks: bigint): string {
  return formatDecimal(specks, 15);
}

/**
 * Write an atomic-unit amount as a decimal, trailing fraction zeros dropped.
 *
 * @param units - The amount in atomic units.
 * @param decimals - The decimal places one whole unit divides into.
 * @returns The decimal amount.
 */
function formatDecimal(units: bigint, decimals: number): string {
  const magnitude: string = (units < 0n ? -units : units).toString().padStart(decimals + 1, "0");
  let fraction: string = magnitude.slice(-decimals);
  while (fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return `${units < 0n ? "-" : ""}${magnitude.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`;
}
