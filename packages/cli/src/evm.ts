// EVM value helpers shared by the vault commands.

// EIP-1559 gas parameters for the ERC20 transfers the MPC signs. An ERC20
// transfer costs ~50-65k gas; the fee caps are generous for Sepolia.
// Double duty: the gas envelope this cli CHOOSES for deposits (the caller's
// account pays those), and the TS mirror of the envelope the CONTRACT FIXES
// for withdrawals (the vault account pays those) — the values MUST stay in
// lockstep with requestWithdraw in erc20-vault.compact, or the withdraw
// expected-record check fails.

/**
 * The ERC20 `transfer(address,uint256)` selector, as broadcast (big-endian).
 * Application-level (this demo's vault moves ERC20s) — the in-circuit twin is
 * the literal `Bytes [0xa9, 0x05, 0x9c, 0xbb]` in erc20-vault.compact.
 */
export const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

/** Gas ceiling of an MPC-signed ERC20 transfer. */
export const ERC20_TRANSFER_GAS_LIMIT = 100_000n;

/** Max total fee per gas of an MPC-signed ERC20 transfer, wei (30 gwei). */
export const ERC20_TRANSFER_MAX_FEE_PER_GAS = 30_000_000_000n;

/** Max priority fee per gas of an MPC-signed ERC20 transfer, wei (1 gwei). */
export const ERC20_TRANSFER_MAX_PRIORITY_FEE_PER_GAS = 1_000_000_000n;

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
