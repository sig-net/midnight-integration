// Byte codecs shared across the package: hex string rendering/parsing and
// fixed-width integer encodings in both byte orders. Big-endian is the SEC1
// order stored signatures and ABI words use, little-endian is the order
// Compact's `Bytes<32> as Field` / `as Secp256k1Scalar` casts read.

/**
 * Render bytes as a lowercase hex string, no `0x` prefix.
 *
 * @param bytes - The bytes to render.
 * @returns Lowercase hex, two chars per byte.
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Strip an optional `0x`/`0X` prefix from a hex string.
 *
 * @param hex - A hex string, with or without a `0x` prefix.
 * @returns The bare hex digits.
 */
export function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/**
 * Decode a hex string into bytes: the inverse of {@link bytesToHex}.
 *
 * @param hex - An even number of hex digits, with or without a `0x` prefix.
 * @returns The decoded bytes.
 * @throws {Error} If the digits are odd-length or not all hex: lenient parsing
 *   would return plausible-looking wrong bytes.
 */
export function hexToBytes(hex: string): Uint8Array {
  const digits = stripHexPrefix(hex);
  if (digits.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(digits)) {
    throw new Error(`not a hex byte string: "${hex}"`);
  }
  const out = new Uint8Array(digits.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(digits.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

/** BLS12-381 scalar field order (the Compact `Field` type modulus). */
export const BLS_ORDER =
  52435875175126190479447740508185965837690552500527637822603658699938581184513n;

/**
 * Little-endian bytes to a bigint: the byte order Compact's
 * `Bytes<32> as Field` / `as Secp256k1Scalar` casts read.
 *
 * @param bytes - Little-endian byte array.
 * @returns The decoded non-negative integer.
 */
export function bytesToBigint(bytes: Uint8Array): bigint {
  let result = 0n;
  let shift = 0n;
  for (const byte of bytes) {
    result |= BigInt(byte) << shift;
    shift += 8n;
  }
  return result;
}

/**
 * A bigint to exactly 32 little-endian bytes: the inverse of
 * {@link bytesToBigint}. Non-negative values encode raw (the full 32-byte
 * range, so secp256k1 scalars above {@link BLS_ORDER} fit). Negative values
 * are interpreted in the BLS scalar field, so their domain is
 * `[-BLS_ORDER, 0)`.
 *
 * @param n - The integer to encode.
 * @returns The 32-byte little-endian encoding.
 * @throws {Error} If the value is below `-BLS_ORDER` or does not fit 32 bytes.
 */
export function bigintToBytes32(n: bigint): Uint8Array {
  if (n < -BLS_ORDER || n >= 1n << 256n) {
    throw new Error(`value does not fit 32 little-endian bytes: ${String(n)}`);
  }
  const buf = new Uint8Array(32);
  let v = n < 0n ? n + BLS_ORDER : n;
  for (let i = 0; i < 32; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/**
 * Big-endian (SEC1) bytes to a bigint: the byte order stored signatures use.
 *
 * @param bytes - Big-endian byte array.
 * @returns The decoded non-negative integer.
 */
export function bytesToBigintBE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/**
 * A bigint to exactly 32 big-endian (SEC1) bytes: the inverse of
 * {@link bytesToBigintBE}.
 *
 * @param value - The non-negative integer to encode.
 * @returns The 32-byte big-endian encoding.
 * @throws {Error} If the value is negative or does not fit 32 bytes.
 */
export function bigintToBytes32BE(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) {
    throw new Error(`value does not fit 32 big-endian bytes: ${String(value)}`);
  }
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
