// Sepolia read-only helpers for funding preflights (per the repo convention,
// ethers is the Ethereum library).

import { Contract, JsonRpcProvider } from "ethers";

/** Canonical Sepolia USDC used by the e2e flow when `ERC20_ADDRESS` is unset. */
export const SEPOLIA_USDC_ADDRESS = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

const ERC20_READ_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

/**
 * Read an address's native ETH balance.
 *
 * @param rpcUrl - JSON-RPC endpoint (e.g. `EVM_RPC_URL`).
 * @param address - The account to query.
 * @returns Balance in wei.
 */
export async function getEthBalance(rpcUrl: string, address: string): Promise<bigint> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    return await provider.getBalance(address);
  } finally {
    provider.destroy();
  }
}

/**
 * Read an address's next transaction nonce (pending count).
 *
 * @param rpcUrl - JSON-RPC endpoint (e.g. `EVM_RPC_URL`).
 * @param address - The account to query.
 * @returns The nonce for the account's next transaction.
 */
export async function getTransactionNonce(rpcUrl: string, address: string): Promise<bigint> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    return BigInt(await provider.getTransactionCount(address, "pending"));
  } finally {
    provider.destroy();
  }
}

/**
 * Read an address's ERC20 token balance along with the token's decimals.
 *
 * @param rpcUrl - JSON-RPC endpoint (e.g. `EVM_RPC_URL`).
 * @param token - The ERC20 contract address.
 * @param holder - The account to query.
 * @returns The raw balance and the token's `decimals()`.
 */
export async function getErc20Balance(
  rpcUrl: string,
  token: string,
  holder: string,
): Promise<{ balance: bigint; decimals: number }> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    const erc20 = new Contract(token, ERC20_READ_ABI, provider);
    const [balance, decimals] = await Promise.all([
      erc20.balanceOf(holder) as Promise<bigint>,
      erc20.decimals() as Promise<bigint>,
    ]);
    return { balance, decimals: Number(decimals) };
  } finally {
    provider.destroy();
  }
}
