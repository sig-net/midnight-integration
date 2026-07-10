// `request-withdraw` — the first half of the withdraw flow: surrender a
// shielded vault coin (burned by the contract) and record a signature request
// asking the MPC to sign an EVM `transfer(destination, amount)` on the ERC20,
// sent from the VAULT's derived address (path = "vault"). The request id is
// recomputed off-chain with the library's TS twin of the request-id circuit
// and asserted against the ledger map key before it is returned.

import { rawTokenType } from "@midnight-ntwrk/compact-runtime";

import {
  asciiPadded,
  calculateRequestId,
  ERC20_TRANSFER_SELECTOR,
  evmAddressAbiWord,
  hexToBytes,
  numericAbiWordValue,
  PATH_BYTES,
  requestIdHex,
  SIGNET_DEFAULT_KEY_VERSION,
  toSignBidirectionalRequestIndex,
  TxParamType,
  type RequestIdHex,
  type SignBidirectionalRequest,
} from "@midnight-erc20-vault/signet-midnight";
import { pureCircuits } from "@midnight-erc20-vault/vault-contract";

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";
import {
  ERC20_TRANSFER_GAS_LIMIT,
  ERC20_TRANSFER_MAX_FEE_PER_GAS,
  ERC20_TRANSFER_MAX_PRIORITY_FEE_PER_GAS,
  evmAddressBytes,
} from "../evm.ts";
import { VAULT_MPC_ROUTING } from "../mpc-routing.ts";
import { readVaultLedger } from "../vault-ledger.ts";

/** Options for {@link requestWithdraw}. */
export interface RequestWithdrawOptions {
  /** Withdraw amount in ERC20 base units. */
  readonly amount: bigint;
  /** Destination EVM address (20-byte 0x hex) receiving the ERC20. */
  readonly destEvmAddress: string;
  /** Nonce of the VAULT's derived EVM account (the withdraw tx sender). */
  readonly evmNonce: bigint;
}

// The MPC derivation path of the vault's own EVM account — mirrors the
// contract-fixed in-circuit literal `pad(256, "vault")` in requestWithdraw.
const VAULT_PATH = asciiPadded("vault", PATH_BYTES);

/**
 * Call the vault's `requestWithdraw` circuit on the deployed contract and
 * return the resulting request id.
 *
 * Surrenders a shielded vault coin of exactly `amount` — the coin's color
 * comes from the compiled `vaultTokenDomainSeparator` circuit plus the
 * runtime's `rawTokenType`, and midnight-js funds its value from the caller's
 * shielded balance when it balances the call. This wallet's own coin public
 * key is pinned as the refund recipient. The circuit takes only the vault
 * account's nonce, the key version, the withdraw arguments, the coin and the
 * refund key: the vault pays the withdraw gas, so the whole fee envelope is
 * contract-fixed (mirrored here by the `ERC20_TRANSFER_*` constants — keep
 * in lockstep). The expected request record is reconstructed off-chain, its
 * id computed with the library's `calculateRequestId` TS twin, and asserted
 * present as a ledger map key after the call.
 *
 * @param context - The CLI context.
 * @param options - The withdraw arguments.
 * @returns The request id as 64-char lowercase hex.
 * @throws If required config is missing, an option is invalid, the vault is
 *   uninitialized, or the recomputed id does not appear on the ledger.
 */
export async function requestWithdraw(context: CliContext, options: RequestWithdrawOptions): Promise<RequestIdHex> {
  const { config } = context;
  const vaultContractAddress = requireConfigValue(config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
  const erc20Address = requireConfigValue(config.erc20Address, "ERC20_ADDRESS");
  if (options.amount <= 0n) {
    throw new Error(`--amount must be a positive integer; got ${options.amount}.`);
  }
  if (options.evmNonce < 0n) {
    throw new Error(`--evm-nonce must be non-negative; got ${options.evmNonce}.`);
  }
  const destEvmAddress = evmAddressBytes(options.destEvmAddress);
  const erc20 = evmAddressBytes(erc20Address);
  console.log(`vault contract: ${vaultContractAddress}`);
  console.log(`erc20:          ${erc20Address}`);
  console.log(`destination:    ${options.destEvmAddress}`);
  console.log(`amount:         ${options.amount} (vault evm nonce ${options.evmNonce})`);

  // Pre-call ledger read: the request nonce the contract will use and the
  // pinned chain config.
  const before = await readVaultLedger(context, vaultContractAddress);
  if (!before.initialized) {
    throw new Error("vault is not initialized — run the initialize command first");
  }
  const requestNonce = before.signetNonce;

  // The surrendered coin: the vault token for THIS erc20, of exactly
  // `amount`, under a fresh random nonce.
  const coin = {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    color: hexToBytes(rawTokenType(pureCircuits.vaultTokenDomainSeparator(erc20), vaultContractAddress)),
    value: options.amount,
  };

  // On EVM failure the surrendered value is re-minted to this wallet's own
  // coin key when the withdrawal settles.
  const refundPk = { bytes: hexToBytes(context.providers.walletProvider.getCoinPublicKey()) };

  const keyVersion = SIGNET_DEFAULT_KEY_VERSION;

  // The record the contract will store, reconstructed byte for byte: the
  // fully contract-composed envelope (the pinned chain, the contract-fixed
  // gas), the contract-built `transfer(destination, amount)` calldata (the
  // raw selector, the big-endian address embed, the LE amount embed), the
  // vault's own derivation path, and the contract-fixed routing.
  const expectedRecord: SignBidirectionalRequest = {
    requestNonce,
    txParamType: TxParamType.evmType2,
    txParams: {
      to: erc20,
      chainId: before.evmChainId,
      nonce: options.evmNonce,
      gasLimit: ERC20_TRANSFER_GAS_LIMIT,
      maxFeePerGas: ERC20_TRANSFER_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: ERC20_TRANSFER_MAX_PRIORITY_FEE_PER_GAS,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
      calldata: {
        is_some: true,
        value: {
          selector: ERC20_TRANSFER_SELECTOR,
          noWords: 2n,
          words: [
            evmAddressAbiWord(destEvmAddress),
            numericAbiWordValue(options.amount),
          ],
        },
      },
    },
    caip2Id: before.caip2Id,
    keyVersion,
    path: VAULT_PATH,
    ...VAULT_MPC_ROUTING,
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));

  const result = await context.vault.callTx.requestWithdraw(
    options.evmNonce,
    keyVersion,
    {
      erc20Address: erc20,
      amount: options.amount,
      destEvmAddress,
    },
    coin,
    refundPk,
  );
  console.log(`requestWithdraw finalized in tx ${result.public.txId}`);

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
  console.log(`request id:     ${expectedIdHex}`);
  return expectedIdHex;
}
