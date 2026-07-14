// `deposit` — record a deposit signature request on the vault's
// ledger. This is the first half of the deposit flow: it asks the MPC to sign
// an EVM `transfer(vault, amount)` on the ERC20, sent from the user's derived
// address. The request id is recomputed off-chain with the library's TS twin
// of the request-id circuit and asserted against the ledger map key before it
// is returned.

import {
  evmAddressAbiWord,
  numericAbiWordValue,
  requestIdHex,
  SIGNET_DEFAULT_KEY_VERSION,
  TxParamType,
  calculateRequestId,
  toSignBidirectionalRequestIndex,
  type SignBidirectionalRequest,
  type RequestIdHex,
} from "@sig-net/midnight";

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";
import {
  ERC20_TRANSFER_SELECTOR,
  ERC20_TRANSFER_GAS_LIMIT,
  ERC20_TRANSFER_MAX_FEE_PER_GAS,
  ERC20_TRANSFER_MAX_PRIORITY_FEE_PER_GAS,
  evmAddressBytes,
} from "../evm.ts";
import { getUserIdentity } from "../identity.ts";
import { VAULT_MPC_ROUTING } from "../mpc-routing.ts";
import { readVaultLedger } from "../vault-ledger.ts";

/** Options for {@link deposit}. */
export interface DepositOptions {
  /** Deposit amount in ERC20 base units. */
  readonly amount: bigint;
  /** Nonce of the user's derived EVM account (the sweep tx sender). */
  readonly evmNonce: bigint;
}

/**
 * Call the vault's `deposit` circuit on the deployed contract and
 * return the resulting request id.
 *
 * The circuit takes only what the caller genuinely chooses: their derived
 * account's nonce, the gas envelope (this command uses the shared
 * `ERC20_TRANSFER_*` defaults — the caller's account pays), the MPC key
 * version, their identity path, and the deposit itself. Everything else —
 * chain, calldata, routing — is contract-composed from the initialize-pinned
 * config. The expected request record is reconstructed off-chain (chain
 * fields read from the ledger, routing from the {@link VAULT_MPC_ROUTING}
 * mirror), its id computed with the library's `calculateRequestId` TS twin,
 * and asserted present as a ledger map key after the call.
 *
 * @param context - The CLI context.
 * @param options - The deposit arguments.
 * @returns The request id as 64-char lowercase hex.
 * @throws If required config is missing, the vault is uninitialized, or the
 *   recomputed id does not appear on the ledger.
 */
export async function deposit(context: CliContext, options: DepositOptions): Promise<RequestIdHex> {
  const { config } = context;
  const vaultContractAddress = requireConfigValue(config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
  const erc20Address = requireConfigValue(config.erc20Address, "ERC20_ADDRESS");
  if (options.amount <= 0n) {
    throw new Error(`--amount must be a positive integer; got ${options.amount}.`);
  }
  if (options.evmNonce < 0n) {
    throw new Error(`--evm-nonce must be non-negative; got ${options.evmNonce}.`);
  }
  const erc20 = evmAddressBytes(erc20Address);
  const identity = getUserIdentity(config);
  console.log(`vault contract:    ${vaultContractAddress}`);
  console.log(`erc20:             ${erc20Address}`);
  console.log(`amount:            ${options.amount} (evm nonce ${options.evmNonce})`);
  console.log(`caller commitment: ${identity.commitmentHex}`);

  // Pre-call ledger read: the request nonce the contract will use, the sealed
  // vault EVM address its calldata will pay to, and the pinned chain config.
  const before = await readVaultLedger(context, vaultContractAddress);
  if (!before.initialized) {
    throw new Error("vault is not initialized — run the initialize command first");
  }
  const requestNonce = before.signetNonce;
  const vaultEvmAddress = before.vaultEvmAddress;

  const gasLimit = ERC20_TRANSFER_GAS_LIMIT;
  const maxFeePerGas = ERC20_TRANSFER_MAX_FEE_PER_GAS;
  const maxPriorityFeePerGas = ERC20_TRANSFER_MAX_PRIORITY_FEE_PER_GAS;
  const keyVersion = SIGNET_DEFAULT_KEY_VERSION;

  // The record the contract will store, reconstructed byte for byte: the
  // contract-composed envelope on the initialize-pinned chain, the
  // contract-built `transfer(vaultEvmAddress, amount)` calldata (the raw
  // selector, the big-endian address embed, the LE amount embed), and the
  // contract-fixed routing.
  const expectedRecord: SignBidirectionalRequest = {
    requestNonce,
    txParamType: TxParamType.evmType2,
    txParams: {
      to: erc20,
      chainId: before.evmChainId,
      nonce: options.evmNonce,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
      calldata: {
        is_some: true,
        value: {
          selector: ERC20_TRANSFER_SELECTOR,
          noWords: 2n,
          words: [
            evmAddressAbiWord(vaultEvmAddress),
            numericAbiWordValue(options.amount),
          ],
        },
      },
    },
    caip2Id: before.caip2Id,
    keyVersion,
    path: identity.path,
    ...VAULT_MPC_ROUTING,
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));

  const result = await context.vault.callTx.deposit(
    options.evmNonce,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    keyVersion,
    identity.path,
    {
      erc20Address: erc20,
      amount: options.amount,
    },
  );
  console.log(`deposit finalized in tx ${result.public.txId}`);

  // The ledger map key IS the domain-separated record hash — recomputing it
  // off-chain and finding it on the ledger proves both sides agree on every
  // byte of the request.
  const after = await readVaultLedger(context, vaultContractAddress);
  const index = toSignBidirectionalRequestIndex(after.signetRequestsIndex);
  if (!index.has(expectedIdHex)) {
    throw new Error(
      `recomputed request id ${expectedIdHex} not found on the ledger — ` +
        `present ids: [${[...index.keys()].join(", ")}] (was another request submitted concurrently?)`,
    );
  }
  console.log(`request id:        ${expectedIdHex}`);
  return expectedIdHex;
}
