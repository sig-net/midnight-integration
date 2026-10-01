import { deserialize, type Schema, serialize } from "borsh";

export type { Schema } from "borsh";

/** Values accepted by the native Borsh decoder and encoder. */
export type BorshValue = ReturnType<typeof deserialize>;

/**
 * Encode a value using borsh-js, optionally extending the output with zero padding.
 *
 * @param schema - Native borsh-js schema.
 * @param value - Value in the representation required by borsh-js.
 * @param length - Optional total output length.
 * @returns Borsh bytes with optional trailing zeros.
 * @throws {Error} If Borsh rejects the input or the requested length is invalid or too small.
 */
export function compactSerialize(schema: Schema, value: BorshValue, length?: number): Uint8Array {
  const bytes = serialize(schema, value);
  if (length === undefined) return bytes;
  if (!Number.isSafeInteger(length) || length < bytes.length) {
    throw new RangeError(
      "Output length must be an integer at least as large as the Borsh encoding",
    );
  }
  const padded = new Uint8Array(length);
  padded.set(bytes);
  return padded;
}

/**
 * Decode using borsh-js, including its native trailing-byte behaviour.
 *
 * @param schema - Native borsh-js schema.
 * @param bytes - Borsh bytes, optionally followed by padding.
 * @returns The value returned by borsh-js.
 * @throws {Error} If Borsh rejects the schema or bytes.
 */
export function compactDeserialize(schema: Schema, bytes: Uint8Array): BorshValue {
  return deserialize(schema, bytes);
}
