// `read-state` — read and print the vault's public ledger through the vault
// SDK: raw contract state from the indexer provider, decoded with the
// generated `ledger()`. No proving keys or transactions involved.

import { toSignBidirectionalRequestIndex } from "@midnight-erc20-vault/signet-midnight";
import { ledger } from "@midnight-erc20-vault/vault-contract";

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/**
 * Read and print the vault's public ledger state: initialization status, the
 * configured vault EVM address, and the pending signet signature requests
 * (ledger field 0).
 *
 * @param context - The CLI context.
 * @throws If no contract state exists at the configured address.
 */
export async function readState(context: CliContext): Promise<void> {
  const vaultContractAddress = requireConfigValue(context.config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");

  const contractState = await context.providers.publicDataProvider.queryContractState(vaultContractAddress);
  if (!contractState) {
    throw new Error(`no contract state found at ${vaultContractAddress} — is the address right?`);
  }

  const state = ledger(contractState.data);
  console.log(`vault contract:    ${vaultContractAddress}`);
  console.log(`initialized:       ${state.initialized}`);
  console.log(`vault EVM address: 0x${hex(state.vaultEvmAddress)}`);
  // caip2Id is zero-padded ASCII; NUL-trim for display.
  console.log(`EVM chain:         ${state.evmChainId} (${new TextDecoder().decode(state.caip2Id).replace(/\0+$/u, "")})`);

  const index = toSignBidirectionalRequestIndex(state.signetRequestsIndex);
  console.log(`pending signature requests: ${index.size}`);
  for (const [requestIdHex, request] of index) {
    console.log(`- ${requestIdHex} (requestNonce ${request.requestNonce})`);
  }
}
