/**
 * Signet Standard Codec
 *
 * Handles the 2-byte big-endian length prefix convention for
 * variable-length data in fixed-size Compact Bytes<N> fields.
 *
 * Format: [length_hi, length_lo, ...payload, ...zero_padding]
 * Total size always equals N (the Compact Bytes<N> size).
 */

/**
 * Encode variable-length data into a fixed-size buffer with a 2-byte length prefix.
 *
 * @param data The actual payload bytes
 * @param totalSize The Compact Bytes<N> size (e.g., 512 for Bytes<512>)
 * @returns Uint8Array of exactly `totalSize` bytes
 */
export function encodeLengthPrefixed(data: Uint8Array, totalSize: number): Uint8Array {
  const maxPayload = totalSize - 2;
  if (data.length > maxPayload) {
    throw new Error(`Data length ${data.length} exceeds max payload ${maxPayload} for Bytes<${totalSize}>`);
  }
  const result = new Uint8Array(totalSize);
  result[0] = (data.length >> 8) & 0xff;
  result[1] = data.length & 0xff;
  result.set(data, 2);
  return result;
}

/**
 * Decode a length-prefixed Bytes<N> buffer back to the actual variable-length payload.
 *
 * @param bytes The full Bytes<N> buffer (including 2-byte length prefix)
 * @returns The actual payload (without padding)
 */
export function decodeLengthPrefixed(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 2) {
    throw new Error(`Buffer too small: ${bytes.length} bytes, need at least 2`);
  }
  const length = (bytes[0] << 8) | bytes[1];
  if (length > bytes.length - 2) {
    throw new Error(`Encoded length ${length} exceeds available data ${bytes.length - 2}`);
  }
  return bytes.slice(2, 2 + length);
}

/**
 * Encode a UTF-8 string into a length-prefixed Bytes<N> buffer.
 */
export function encodeString(str: string, totalSize: number): Uint8Array {
  return encodeLengthPrefixed(new TextEncoder().encode(str), totalSize);
}

/**
 * Decode a length-prefixed Bytes<N> buffer into a UTF-8 string.
 */
export function decodeString(bytes: Uint8Array): string {
  return new TextDecoder().decode(decodeLengthPrefixed(bytes));
}
