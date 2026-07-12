// The vault's shielded token color, computed the sanctioned way: the
// contract's compiled `vaultTokenDomainSeparator` circuit plus the runtime's
// `rawTokenType` (the off-chain twin of the in-circuit
// `tokenType(domainSep, kernel.self())`) — never a TS re-implementation.
// Shared by the withdraw command (the surrendered coin's color) and by tests
// that read a wallet's shielded balance of the vault token.

import { rawTokenType, type ContractAddress, type RawTokenType } from "@midnight-ntwrk/compact-runtime";

import { pureCircuits } from "@midnight-erc20-vault/vault-contract";

import { evmAddressBytes } from "./evm.ts";

/**
 * Compute the shielded token color the vault at `vaultContractAddress` mints
 * for `erc20Address` — the key coins of this token carry in ledger state and
 * wallet balance maps.
 *
 * @param erc20Address - The ERC20 token contract on the target chain (20-byte 0x hex).
 * @param vaultContractAddress - The deployed vault contract address.
 * @returns The raw token type (hex) of the vault token for this ERC20.
 * @throws If `erc20Address` is not a 20-byte 0x hex string.
 */
export function vaultTokenType(erc20Address: string, vaultContractAddress: ContractAddress): RawTokenType {
  return rawTokenType(pureCircuits.vaultTokenDomainSeparator(evmAddressBytes(erc20Address)), vaultContractAddress);
}
