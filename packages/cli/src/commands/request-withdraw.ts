// `request-withdraw` — the first half of the withdraw flow: surrender a
// shielded vault coin and record a signature request asking the MPC to sign
// an EVM transfer from the vault's derived address to the destination.

import type { SignetRequestIdHex } from "@midnight-erc20-vault/signet-midnight";

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";
import { NotImplementedError } from "../errors.ts";

/** Options for {@link requestWithdraw}. */
export interface RequestWithdrawOptions {
  /** Withdraw amount in ERC20 base units. */
  readonly amount: bigint;
  /** Destination EVM address (20-byte 0x hex) receiving the ERC20. */
  readonly destEvmAddress: string;
}

/**
 * Call the vault's `requestWithdraw` circuit and return the request id.
 *
 * Wired behavior: the circuit takes the shielded vault coin into escrow UP
 * FRONT (a coin-bearing call, balanced by midnight-js's callTx), pins a
 * refund recipient, and records the signature request with `path = "vault"`
 * so the MPC signs from the VAULT's derived EVM address.
 *
 * @param context - The CLI context.
 * @param options - The withdraw arguments.
 * @returns The request id as 64-char lowercase hex.
 * @throws NotImplementedError — the `requestWithdraw` circuit is not yet
 * ported to the vault contract.
 */
export async function requestWithdraw(context: CliContext, options: RequestWithdrawOptions): Promise<SignetRequestIdHex> {
  const vaultContractAddress = requireConfigValue(context.config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
  if (!/^0x[0-9a-fA-F]{40}$/.test(options.destEvmAddress)) {
    throw new Error(`--dest-evm-address must be a 20-byte 0x hex address; got "${options.destEvmAddress}".`);
  }
  console.log(`vault contract: ${vaultContractAddress}`);
  console.log(`destination:    ${options.destEvmAddress}`);
  console.log(`amount:         ${options.amount}`);
  throw new NotImplementedError("the requestWithdraw circuit is not yet ported to the vault contract");
}
