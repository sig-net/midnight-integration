// `request-deposit` — record a deposit signature request on the vault's
// ledger. This is the first half of the deposit flow: it asks the MPC to sign
// an EVM `transfer(vault, amount)` on the ERC20, sent from the user's derived
// address. The request id is recomputed off-chain with the library's TS twin
// of the request-id circuit and asserted against the ledger map key before it
// is returned.

import {
  ALGO_BYTES,
  asciiPadded,
  CAIP2_ID_BYTES,
  DEST_BYTES,
  ERC20_TRANSFER_SELECTOR,
  evmAddressAbiWord,
  MPC_PARAMS_BYTES,
  numericAbiWordValue,
  OUTPUT_DESERIALIZATION_SCHEMA_BYTES,
  RESPOND_SERIALIZATION_SCHEMA_BYTES,
  requestIdHex,
  SIGNET_ALGO_ECDSA,
  SIGNET_DEFAULT_KEY_VERSION,
  SIGNET_DEST_ETHEREUM,
  TxParamType,
  calculateRequestId,
  toSignBidirectionalRequestIndex,
  type EVMType2TxParams,
  type SignBidirectionalRequest,
  type RequestIdHex,
} from "@midnight-erc20-vault/signet-midnight";
import { ledger } from "@midnight-erc20-vault/vault-contract";

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
 * Builds the typed circuit arguments — the EVM tx envelope, the flat MPC
 * routing args bound to the caller's identity path, and the deposit request
 * (`erc20Address`, `amount`) — and submits through
 * `context.vault.callTx`. The expected request record (including the
 * contract-built `transfer(vault, amount)` calldata) is reconstructed
 * off-chain, its id computed with the library's `calculateRequestId`
 * TS twin, and asserted present as a ledger map key after the call.
 *
 * @param context - The CLI context.
 * @param options - The deposit arguments.
 * @returns The request id as 64-char lowercase hex.
 * @throws If required config is missing, the vault is uninitialized, or the
 *   recomputed id does not appear on the ledger.
 */
export async function requestDeposit(context: CliContext, options: RequestDepositOptions): Promise<RequestIdHex> {
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

  // The caller-supplied tx envelope. Calldata is `none`: the CONTRACT builds
  // it (the Maybe's default value still carries the vault's <2, 0, 0>
  // capacities the generated argument check demands).
  const zeroWord = new Uint8Array(32);
  const txParams: EVMType2TxParams = {
    to: evmAddressBytes(erc20Address),
    chainId: evmChainId,
    nonce: options.evmNonce,
    gasLimit: GAS_LIMIT,
    maxFeePerGas: MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
    value: 0n,
    accessListEntryCount: 0n,
    accessList: [],
    calldata: {
      is_some: false,
      value: { selector: new Uint8Array(4), noWords: 0n, words: [zeroWord, zeroWord] },
    },
  };
  const routing = {
    caip2Id: asciiPadded(caip2Id, CAIP2_ID_BYTES),
    keyVersion: SIGNET_DEFAULT_KEY_VERSION,
    path: identity.path,
    algo: asciiPadded(SIGNET_ALGO_ECDSA, ALGO_BYTES),
    dest: asciiPadded(SIGNET_DEST_ETHEREUM, DEST_BYTES),
    params: new Uint8Array(MPC_PARAMS_BYTES),
    outputDeserializationSchema: asciiPadded(RESULT_SCHEMA, OUTPUT_DESERIALIZATION_SCHEMA_BYTES),
    respondSerializationSchema: asciiPadded(RESULT_SCHEMA, RESPOND_SERIALIZATION_SCHEMA_BYTES),
  };

  // The record the contract will store: the caller's envelope with the
  // contract-built calldata swapped in — `transfer(vaultEvmAddress, amount)`
  // as words (never caller-supplied): the raw selector, the big-endian address
  // embed, the LE amount embed.
  const expectedRecord: SignBidirectionalRequest = {
    requestNonce,
    txParamType: TxParamType.evmType2,
    txParams: {
      ...txParams,
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
    ...routing,
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));

  const result = await context.vault.callTx.requestDeposit(
    txParams,
    routing.caip2Id,
    routing.keyVersion,
    routing.path,
    routing.algo,
    routing.dest,
    routing.params,
    routing.outputDeserializationSchema,
    routing.respondSerializationSchema,
    {
      erc20Address: evmAddressBytes(erc20Address),
      amount: options.amount,
    },
  );
  console.log(`requestDeposit finalized in tx ${result.public.txId}`);

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
