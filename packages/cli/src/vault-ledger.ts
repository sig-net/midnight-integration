// Shared vault ledger read used by the vault commands: raw contract state
// from the public data provider, decoded with the generated `ledger()`.

import { ledger } from "@midnight-erc20-vault/vault-contract";

import type { CliContext } from "./context.ts";

/** The decoded vault public ledger state, as the generated `ledger()` returns it. */
export type VaultLedgerState = ReturnType<typeof ledger>;

/**
 * Read + decode the vault's public ledger state.
 *
 * @param context - The CLI context.
 * @param vaultContractAddress - The deployed vault contract address.
 * @returns The decoded ledger state.
 * @throws If no contract state exists at `vaultContractAddress`.
 */
export async function readVaultLedger(context: CliContext, vaultContractAddress: string): Promise<VaultLedgerState> {
  const contractState = await context.providers.publicDataProvider.queryContractState(vaultContractAddress);
  if (!contractState) {
    throw new Error(`no contract state found at ${vaultContractAddress} — is the address right?`);
  }
  return ledger(contractState.data);
}
