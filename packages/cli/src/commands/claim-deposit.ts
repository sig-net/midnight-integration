// `claim-deposit` — the second half of the deposit flow: present the MPC's
// Schnorr-signed attestation of the EVM sweep to the vault, which verifies it
// in-circuit and mints shielded tokens to the caller.

import type { SignetRequestIdHex } from "@midnight-erc20-vault/signet-midnight";

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";
import { NotImplementedError } from "../errors.ts";

/** Options for {@link claimDeposit}. */
export interface ClaimDepositOptions {
  /** The request id being claimed. */
  readonly requestId: SignetRequestIdHex;
}

/**
 * Call the vault's `claimDeposit` circuit for a completed deposit request.
 *
 * Wired behavior: fetch the MPC's response (`outputData` + Schnorr signature
 * components) for `requestId` from the signature-responses contract, then
 * call the circuit, which verifies the MPC public key hash, the Schnorr
 * signature, the EVM success flag, and the caller identity against the
 * stored request — and mints shielded vault tokens on success. The mint's
 * coin handling is midnight-js's job: `vault.callTx.claimDeposit(...)`
 * balances the resulting offer like any other call.
 *
 * @param context - The CLI context.
 * @param options - The claim arguments.
 * @throws NotImplementedError — the `claimDeposit` circuit is not yet ported
 * to the vault contract.
 */
export async function claimDeposit(context: CliContext, options: ClaimDepositOptions): Promise<void> {
  const vaultContractAddress = requireConfigValue(context.config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
  console.log(`vault contract: ${vaultContractAddress}`);
  console.log(`request id:     ${options.requestId}`);
  throw new NotImplementedError("the claimDeposit circuit is not yet ported to the vault contract");
}
