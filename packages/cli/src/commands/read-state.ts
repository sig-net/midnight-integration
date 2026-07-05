// `read-state` — decode the vault's public ledger the MPC-convention way:
// raw contract state from the indexer, walked with the shared state reader.
// No compiled contract, no wallet, no proving keys.

import { readSignetEVMSignatureRequestIndexFromState } from "@midnight-erc20-vault/signet-midnight";

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";

/**
 * Read and print the vault's signet request index (ledger field 0) from the
 * deployed contract at `VAULT_CONTRACT_ADDRESS`.
 *
 * Uses the raw state walk (`readSignetEVMSignatureRequestIndexFromState`)
 * rather than the compiled contract's `ledger()`, so a successful run doubles
 * as a from-the-outside proof that the MPC read convention works against a
 * real indexer.
 *
 * @param context - The CLI context.
 * @throws NotImplementedError — until the context's public-data provider is
 * wired.
 */
export async function readState(context: CliContext): Promise<void> {
  const vaultContractAddress = requireConfigValue(context.config.vaultContractAddress, "VAULT_CONTRACT_ADDRESS");
  console.log(`vault contract: ${vaultContractAddress}`);
  console.log(`indexer:        ${context.config.midnightNodeConfig.indexerUrl}`);

  const publicDataProvider = await context.publicDataProvider();
  const contractState = await publicDataProvider.queryContractState(vaultContractAddress);
  if (!contractState) {
    throw new Error(`no contract state found at ${vaultContractAddress} — is the address right?`);
  }

  const index = readSignetEVMSignatureRequestIndexFromState(contractState.data);
  console.log(`pending signature requests: ${index.size}`);
  for (const [requestIdHex, request] of index) {
    console.log(`- ${requestIdHex} (requestNonce ${request.requestNonce})`);
  }
}
