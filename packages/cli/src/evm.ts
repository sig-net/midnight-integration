// EVM value helpers shared by the vault commands.

/**
 * Decode a 20-byte 0x-prefixed hex EVM address to its raw bytes.
 *
 * @param hex - The address, e.g. `0xA0c8…1514`.
 * @returns The 20 address bytes.
 * @throws If the input is not a 20-byte 0x hex string.
 */
export function evmAddressBytes(hex: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(hex)) {
    throw new Error(`expected a 20-byte 0x hex EVM address; got "${hex}".`);
  }
  return Uint8Array.from(
    hex
      .slice(2)
      .match(/.{2}/g)!
      .map((byte) => parseInt(byte, 16)),
  );
}
