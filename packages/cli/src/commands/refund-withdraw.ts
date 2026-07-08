// `refund-withdraw` — the completion call of the withdraw flow. Despite the
// name it settles BOTH branches: on EVM success the withdrawal is final; on
// failure the escrowed value is re-minted to the pinned refund recipient.
// Permissionless: anyone may call it, the refund always goes to the pinned
// recipient.

import type { SignetRequestIdHex } from "@midnight-erc20-vault/signet-midnight";

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";
import { NotImplementedError } from "../errors.ts";

/** Options for {@link refundWithdraw}. */
export interface RefundWithdrawOptions {
  /** The request id being completed. */
  readonly requestId: SignetRequestIdHex;
}

/**
 * Call the vault's `refundWithdraw` circuit for a completed withdraw request.
 *
 * Wired behavior: fetch the MPC's Schnorr-signed `(requestId, serializedOutput)`
 * attestation from the signet contract, then call the circuit,
 * which verifies the MPC public key hash and signature and branches on the
 * EVM result: success finalizes the withdrawal; failure re-mints the
 * escrowed vault tokens to the pinned refund recipient.
 *
 * @param context - The CLI context.
 * @param options - The completion arguments.
 * @throws NotImplementedError — the `refundWithdraw` circuit is not yet
 * ported to the vault contract.
 */
export async function refundWithdraw(context: CliContext, options: RefundWithdrawOptions): Promise<void> {
  const vaultContractAddress = requireConfigValue(context.config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
  console.log(`vault contract: ${vaultContractAddress}`);
  console.log(`request id:     ${options.requestId}`);
  throw new NotImplementedError("the refundWithdraw circuit is not yet ported to the vault contract");
}
