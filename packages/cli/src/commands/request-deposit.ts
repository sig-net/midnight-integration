// `request-deposit` — record a deposit signature request on the vault's
// ledger. This is the first half of the deposit flow: it asks the MPC to sign
// an EVM sweep of the user's derived address into the vault's address.

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";
import { NotImplementedError } from "../errors.ts";
import { getUserIdentity } from "../identity.ts";

/** Options for {@link requestDeposit}. */
export interface RequestDepositOptions {
  /** Deposit amount in ERC20 base units. */
  readonly amount: bigint;
  /** Nonce of the user's derived EVM account (the sweep tx sender). */
  readonly evmNonce: bigint;
}

/**
 * Call the vault's `requestDeposit` circuit on the deployed contract and
 * return the resulting request id.
 *
 * Wired behavior: derive the caller identity (commitment + MPC path), build
 * the typed circuit arguments — `signetParams` (EVM transaction params for
 * the sweep + MPC routing with `path` and `caip2Id` from the config) and the
 * deposit request (`erc20Address`, `amount`) — then
 * `vault.callTx.requestDeposit(signetParams, depositRequest)` via the
 * context's joined handle. Afterwards recompute the request id off-chain with
 * the compiled `signetEVMSignatureRequestId` circuit and assert it matches
 * the ledger's map key before returning it.
 *
 * @param context - The CLI context.
 * @param options - The deposit arguments.
 * @returns The request id as 64-char lowercase hex.
 * @throws NotImplementedError — the argument construction still needs the MPC
 * routing constants (keyVersion, algo, dest, schemas) and gas defaults ported
 * from the MVP, and the context's vault join is not wired.
 */
export async function requestDeposit(context: CliContext, options: RequestDepositOptions): Promise<string> {
  const { config } = context;
  const vaultContractAddress = requireConfigValue(config.vaultContractAddress, "VAULT_CONTRACT_ADDRESS");
  const erc20Address = requireConfigValue(config.erc20Address, "ERC20_ADDRESS");
  const caip2Id = requireConfigValue(config.caip2Id, "EVM_CHAIN_ID");
  if (options.amount <= 0n) {
    throw new Error(`--amount must be a positive integer; got ${options.amount}.`);
  }
  const identity = getUserIdentity(config);
  console.log(`vault contract:    ${vaultContractAddress}`);
  console.log(`erc20:             ${erc20Address} on ${caip2Id}`);
  console.log(`amount:            ${options.amount} (evm nonce ${options.evmNonce})`);
  console.log(`caller commitment: ${identity.commitmentHex}`);
  throw new NotImplementedError(
    "request-deposit needs the joined vault handle from the context (not wired) and the MPC routing " +
      "constants/codec ported from the MVP to construct the signet request arguments",
  );
}
