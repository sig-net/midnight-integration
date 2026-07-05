// `initialize` — the deployer's one-off call sealing the vault's EVM address
// into the contract config. Gated in-circuit to the deployer identity.

import type { CliContext } from "../context.ts";
import { evmAddressBytes } from "../evm.ts";
import { getUserIdentity } from "../identity.ts";

/** Options for {@link initialize}. */
export interface InitializeOptions {
  /** The vault's EVM address (20-byte 0x hex) to seal into the contract. */
  readonly vaultEvmAddress: string;
}

/**
 * Call the vault's `initialize` circuit on the deployed contract.
 *
 * The caller must be the DEPLOYER identity: the circuit compares the
 * `callerSecretKey` witness commitment against the sealed `deployer` field,
 * so `VAULT_USER_SECRET_KEY` must hold the deployer's secret for this
 * command.
 *
 * @param context - The CLI context.
 * @param options - The initialize arguments.
 * @throws If the address is malformed or the circuit rejects the caller.
 */
export async function initialize(context: CliContext, options: InitializeOptions): Promise<void> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(options.vaultEvmAddress)) {
    throw new Error(`--vault-evm-address must be a 20-byte 0x hex address; got "${options.vaultEvmAddress}".`);
  }
  const identity = getUserIdentity(context.config);
  console.log(`vault contract:    ${context.config.vaultContractAddress}`);
  console.log(`vault EVM address: ${options.vaultEvmAddress}`);
  console.log(`caller commitment: ${identity.commitmentHex} (must equal the sealed deployer)`);

  const result = await context.vault.callTx.initialize(evmAddressBytes(options.vaultEvmAddress));
  console.log(`initialize finalized in tx ${result.public.txId}`);
}
