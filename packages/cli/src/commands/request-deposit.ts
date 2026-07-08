// `request-deposit` — record a deposit signature request on the vault's
// ledger. This is the first half of the deposit flow: it asks the MPC to sign
// an EVM `transfer(vault, amount)` on the ERC20, sent from the user's derived
// address. The request id is recomputed off-chain with the compiled library
// circuit and asserted against the ledger map key before it is returned.

import {
  ALGO_BYTES,
  asciiPadded,
  bigintToBytes32,
  CAIP2_ID_BYTES,
  DEST_BYTES,
  FUNC_SIG_BYTES,
  MPC_PARAMS_BYTES,
  OUTPUT_DESERIALIZATION_SCHEMA_BYTES,
  RESPOND_SERIALIZATION_SCHEMA_BYTES,
  requestIdHex,
  SIGNET_ALGO_ECDSA,
  SIGNET_DEFAULT_KEY_VERSION,
  SIGNET_DEST_ETHEREUM,
  toSignetEVMSignatureRequestIndex,
  type SignetEVMSignatureRequest,
  type SignetEVMSignatureRequestParams,
  type SignetRequestIdHex,
} from "@midnight-erc20-vault/signet-midnight";
import { ledger, vaultSignetCircuits } from "@midnight-erc20-vault/vault-contract";

import { requireConfigValue } from "../config.ts";
import type { CliContext } from "../context.ts";
import { evmAddressBytes } from "../evm.ts";
import { getUserIdentity } from "../identity.ts";

/** Options for {@link requestDeposit}. */
export interface RequestDepositOptions {
  /** Deposit amount in ERC20 base units. */
  readonly amount: bigint;
  /** Nonce of the user's derived EVM account (the sweep tx sender). */
  readonly evmNonce: bigint;
}

// EIP-1559 gas parameters for the ERC20 transfer the MPC signs. An ERC20
// transfer costs ~50-65k gas; fee caps are generous for Sepolia.
const GAS_LIMIT = 100_000n;
const MAX_FEE_PER_GAS = 30_000_000_000n; // 30 gwei
const MAX_PRIORITY_FEE_PER_GAS = 1_000_000_000n; // 1 gwei

// What the MPC reports back about the EVM call: an ERC20 `transfer` returns a
// single bool.
const RESULT_SCHEMA = '[{"name":"success","type":"bool"}]';

/** Read + decode the vault's public ledger state, throwing if absent. */
async function readVaultLedger(context: CliContext, vaultContractAddress: string) {
  const contractState = await context.providers.publicDataProvider.queryContractState(vaultContractAddress);
  if (!contractState) {
    throw new Error(`no contract state found at ${vaultContractAddress} — is the address right?`);
  }
  return ledger(contractState.data);
}

/**
 * Call the vault's `requestDeposit` circuit on the deployed contract and
 * return the resulting request id.
 *
 * Builds the typed circuit arguments — `signetParams` (EVM transaction params
 * for the ERC20 transfer + MPC routing bound to the caller's identity path)
 * and the deposit request (`erc20Address`, `amount`) — and submits through
 * `context.vault.callTx`. The expected request record (including the
 * contract-built `transfer(vault, amount)` calldata) is reconstructed
 * off-chain, its id computed with the compiled `signetEVMSignatureRequestId`
 * circuit, and asserted present as a ledger map key after the call.
 *
 * @param context - The CLI context.
 * @param options - The deposit arguments.
 * @returns The request id as 64-char lowercase hex.
 * @throws If required config is missing, the vault is uninitialized, or the
 *   recomputed id does not appear on the ledger.
 */
export async function requestDeposit(context: CliContext, options: RequestDepositOptions): Promise<SignetRequestIdHex> {
  const { config } = context;
  const vaultContractAddress = requireConfigValue(config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
  const erc20Address = requireConfigValue(config.erc20Address, "ERC20_ADDRESS");
  const caip2Id = requireConfigValue(config.caip2Id, "EVM_CHAIN_ID");
  const evmChainId = requireConfigValue(config.evmChainId, "EVM_CHAIN_ID");
  if (options.amount <= 0n) {
    throw new Error(`--amount must be a positive integer; got ${options.amount}.`);
  }
  if (options.evmNonce < 0n) {
    throw new Error(`--evm-nonce must be non-negative; got ${options.evmNonce}.`);
  }
  const identity = getUserIdentity(config);
  console.log(`vault contract:    ${vaultContractAddress}`);
  console.log(`erc20:             ${erc20Address} on ${caip2Id}`);
  console.log(`amount:            ${options.amount} (evm nonce ${options.evmNonce})`);
  console.log(`caller commitment: ${identity.commitmentHex}`);

  // Pre-call ledger read: the request nonce the contract will use, and the
  // sealed vault EVM address its calldata will pay to.
  const before = await readVaultLedger(context, vaultContractAddress);
  if (!before.initialized) {
    throw new Error("vault is not initialized — run the initialize command first");
  }
  const requestNonce = before.signetNonce;
  const vaultEvmAddress = before.vaultEvmAddress;

  const signetParams: SignetEVMSignatureRequestParams = {
    evmTransaction: {
      to: evmAddressBytes(erc20Address),
      chainId: evmChainId,
      nonce: options.evmNonce,
      gasLimit: GAS_LIMIT,
      maxFeePerGas: MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
      value: 0n,
    },
    mpcRouting: {
      caip2Id: asciiPadded(caip2Id, CAIP2_ID_BYTES),
      keyVersion: SIGNET_DEFAULT_KEY_VERSION,
      path: identity.path,
      algo: asciiPadded(SIGNET_ALGO_ECDSA, ALGO_BYTES),
      dest: asciiPadded(SIGNET_DEST_ETHEREUM, DEST_BYTES),
      params: new Uint8Array(MPC_PARAMS_BYTES),
      outputDeserializationSchema: asciiPadded(RESULT_SCHEMA, OUTPUT_DESERIALIZATION_SCHEMA_BYTES),
      respondSerializationSchema: asciiPadded(RESULT_SCHEMA, RESPOND_SERIALIZATION_SCHEMA_BYTES),
    },
  };

  // The record the contract will store: caller-supplied params + the
  // contract-built calldata `transfer(vaultEvmAddress, amount)` (D4 — never
  // caller-supplied). `Bytes<20> as Field as Bytes<32>` is a little-endian
  // embed: address bytes then zero padding.
  const vaultAddressWord = new Uint8Array(32);
  vaultAddressWord.set(vaultEvmAddress);
  const expectedRecord: SignetEVMSignatureRequest = {
    requestNonce,
    evmTransaction: signetParams.evmTransaction,
    calldata: {
      funcSig: asciiPadded("transfer(address,uint256)", FUNC_SIG_BYTES),
      argCount: 2n,
      args: [vaultAddressWord, bigintToBytes32(options.amount)],
    },
    mpcRouting: signetParams.mpcRouting,
  };
  const expectedIdHex = requestIdHex(vaultSignetCircuits.signetEVMSignatureRequestId(expectedRecord));

  const result = await context.vault.callTx.requestDeposit(signetParams, {
    erc20Address: evmAddressBytes(erc20Address),
    amount: options.amount,
  });
  console.log(`requestDeposit finalized in tx ${result.public.txId}`);

  // The ledger map key IS the domain-separated record hash — recomputing it
  // off-chain and finding it on the ledger proves both sides agree on every
  // byte of the request.
  const after = await readVaultLedger(context, vaultContractAddress);
  const index = toSignetEVMSignatureRequestIndex(after.signetRequestsIndex);
  if (!index.has(expectedIdHex)) {
    throw new Error(
      `recomputed request id ${expectedIdHex} not found on the ledger — ` +
        `present ids: [${[...index.keys()].join(", ")}] (was another request submitted concurrently?)`,
    );
  }
  console.log(`request id:        ${expectedIdHex}`);
  return expectedIdHex;
}
