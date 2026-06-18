/**
 * Signet Standard Constants
 *
 * Standard field names, sizes, and default values matching
 * Hydration's pallet_signet conventions.
 */

// ---- Field Sizes (Compact Bytes<N>) ----
export const CALLDATA_FUNC_SIG_SIZE = 256;
export const CAIP2_ID_SIZE = 64;
export const PATH_SIZE = 256;
export const ALGO_SIZE = 32;
export const DEST_SIZE = 64;
export const PARAMS_SIZE = 512;
export const OUTPUT_SCHEMA_SIZE = 256;
export const RESPOND_SCHEMA_SIZE = 256;
export const OUTPUT_DATA_SIZE = 4096;

// ---- Default Values (matching Hydration's dispenser pallet) ----
export const ECDSA = 'ecdsa';
export const ETHEREUM = 'ethereum';
export const DEFAULT_KEY_VERSION = 0;

// ---- Ledger Field Names ----
// These must match the Compact template exactly.
export const FIELD_NAMES = {
  mpcPubKeyHash: 'mpcPubKeyHash',
  nonce: 'signetNonce',
  requestNonce: 'signetRequestNonce',
  // Calldata (dynamic arg array)
  calldataFuncSig: 'signetCalldataFuncSig',
  calldataArgCount: 'signetCalldataArgCount',
  calldataArgs: 'signetCalldataArgs',
  // EVM transaction parameters
  evmTo: 'signetEvmTo',
  evmChainId: 'signetEvmChainId',
  evmNonce: 'signetEvmNonce',
  evmGasLimit: 'signetEvmGasLimit',
  evmMaxFee: 'signetEvmMaxFee',
  evmPriorityFee: 'signetEvmPriorityFee',
  evmValue: 'signetEvmValue',
  // Routing
  caip2Id: 'signetCaip2Id',
  keyVersion: 'signetKeyVersion',
  path: 'signetPath',
  algo: 'signetAlgo',
  dest: 'signetDest',
  params: 'signetParams',
  outputSchema: 'signetOutputSchema',
  respondSchema: 'signetRespondSchema',
  outputData: 'signetOutputData',
} as const;

// ---- CAIP-2 Helpers ----

/** Build a CAIP-2 chain identifier for an EVM chain. */
export function caip2Evm(chainId: number | bigint): string {
  return `eip155:${chainId}`;
}
