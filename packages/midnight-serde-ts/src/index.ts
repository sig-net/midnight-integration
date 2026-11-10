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
 * Decode using borsh-js, ignoring trailing padding and rejecting any encoding
 * borsh-js would not produce itself, such as a Boolean byte other than 0 or 1,
 * which the compiled Compact deserialize also rejects.
 *
 * @param schema - Native borsh-js schema.
 * @param bytes - Borsh bytes, optionally followed by padding.
 * @returns The value returned by borsh-js.
 * @throws {Error} If Borsh rejects the schema or bytes, or the bytes are not the canonical encoding of the value they decode to.
 */
export function compactDeserialize(schema: Schema, bytes: Uint8Array): BorshValue {
  const value = deserialize(schema, bytes);
  const canonical = serialize(schema, value);
  if (!canonical.every((byte, index) => byte === bytes[index])) {
    throw new Error("Bytes are not the canonical Borsh encoding of the value they decode to");
  }
  return value;
}
