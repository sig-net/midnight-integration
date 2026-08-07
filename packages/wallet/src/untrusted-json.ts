// Field-by-field narrowing of untrusted decoded JSON (wire payloads,
// stored state), throwing context-labelled errors on anything malformed.

/**
 * Narrow an untrusted JSON value to an object record.
 *
 * @param value - The untrusted decoded value.
 * @param context - Label naming the payload for the error message.
 * @returns The value as a string-keyed record.
 * @throws {Error} If the value is not a JSON object.
 */
export function parseRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context}: expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Narrow an untrusted JSON value to a string.
 *
 * @param value - The untrusted decoded value.
 * @param context - Label naming the field for the error message.
 * @returns The string value.
 * @throws {Error} If the value is not a string.
 */
export function parseString(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`${context}: expected a string`);
  }
  return value;
}
