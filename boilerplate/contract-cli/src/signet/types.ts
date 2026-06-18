/**
 * Signet Standard Types
 *
 * Mirrors Hydration's SignBidirectionalRequested event fields
 * for the Midnight implementation.
 *
 * Security model: the contract stores individual typed parameters
 * and a dynamic calldata arg array. The MPC reads these values
 * and builds the ABI calldata + RLP transaction off-chain.
 */

/** EVM gas parameters read from the contract's signet maps. */
export interface EvmGasParams {
  /** Target EVM contract address (20 bytes). */
  evmTo: Uint8Array;
  /** EVM chain ID. */
  evmChainId: bigint;
  /** EVM transaction nonce. */
  evmNonce: bigint;
  /** Gas limit. */
  evmGasLimit: bigint;
  /** Max fee per gas (wei). */
  evmMaxFee: bigint;
  /** Max priority fee per gas (wei). */
  evmPriorityFee: bigint;
  /** ETH value to send (wei). */
  evmValue: bigint;
}

/** Calldata fields read from the contract's signet maps. */
export interface CalldataFields {
  /** EVM function signature, e.g. "transfer(address,uint256)". */
  funcSig: string;
  /** Number of arguments. */
  argCount: number;
  /** Arguments as 32-byte values (ABI word size). */
  args: Uint8Array[];
}

/** A signing request read from a contract's standardized ledger fields. */
export interface SigningRequest {
  /** Contract address — the predecessor (from ContractCall.address). Unforgeable. */
  predecessor: string;
  /** Request ID — the Map key, computed as persistentHash of all signet fields including nonce. */
  requestId: Uint8Array;
  /** Per-request nonce value — ensures identical txs produce different request IDs. */
  nonce: bigint;
  /** EVM gas/tx parameters. */
  evmParams: EvmGasParams;
  /** Calldata fields (function sig + args). */
  calldata: CalldataFields;
  /** CAIP-2 chain identifier, e.g. "eip155:11155111". */
  caip2Id: string;
  /** MPC key version (typically 0). */
  keyVersion: number;
  /** Derivation path — controlled by the contract. */
  path: Uint8Array;
  /** Signing algorithm, e.g. "ecdsa". */
  algo: string;
  /** Destination type, e.g. "ethereum". */
  dest: string;
  /** Additional parameters (contract-specific). */
  params: Uint8Array;
  /** Schema for deserializing the EVM tx output. */
  outputDeserializationSchema: Uint8Array;
  /** Schema for serializing the response back. */
  respondSerializationSchema: Uint8Array;
}

/** A contract being monitored by the MPC. */
export interface MonitoredContract {
  /** On-chain contract address. */
  address: string;
  /** Last seen signetNonce value. */
  lastNonce: bigint;
  /** The mpcPubKeyHash stored on this contract. */
  mpcPubKeyHash: Uint8Array;
}

/** Configuration for the block stream monitor. */
export interface BlockStreamConfig {
  /** Indexer WebSocket URL for the blocks subscription. */
  indexerWsUrl: string;
  /** Indexer HTTP URL for state queries. */
  indexerHttpUrl: string;
  /** The MPC's own public key hash (for contract discovery). */
  mpcPubKeyHash: Uint8Array;
}

/** A signing response broadcast by the MPC via WebSocket. */
export interface SigningResponse {
  /** Request ID (map key). */
  requestId: Uint8Array;
  /** EVM return data (4096 bytes, zero-padded). First 32 bytes = ABI-encoded return value. */
  outputData: Uint8Array;
}
