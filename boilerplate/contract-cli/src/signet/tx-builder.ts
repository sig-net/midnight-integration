/**
 * Signet Standard Transaction Builder
 *
 * Builds RLP-encoded EIP-1559 transactions. Used by the MPC to assemble
 * the unsigned transaction from contract-controlled parameters (gas params
 * + ABI calldata built by calldata-builder.ts).
 *
 * Replaces what pallet_signet::build_evm_tx() does in Hydration — on
 * Midnight the MPC builds the RLP since Compact can't do RLP encoding.
 */

/** Parameters for building an EIP-1559 EVM transaction. */
export interface EvmTxParams {
  /** EVM chain ID (e.g., 11155111 for Sepolia). */
  chainId: bigint;
  /** Sender nonce on the EVM chain. */
  nonce: bigint;
  /** Maximum priority fee per gas (tip), in wei. */
  maxPriorityFeePerGas: bigint;
  /** Maximum total fee per gas, in wei. */
  maxFeePerGas: bigint;
  /** Gas limit for the transaction. */
  gasLimit: bigint;
  /** Destination address (20 bytes). */
  to: Uint8Array;
  /** ETH value to send, in wei. */
  value: bigint;
  /** Transaction calldata. */
  data: Uint8Array;
  /** EIP-2930 access list (optional, defaults to empty). */
  accessList?: Array<[Uint8Array, Uint8Array[]]>;
}

/**
 * Build an unsigned RLP-encoded EIP-1559 transaction.
 *
 * Format: 0x02 || RLP([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas,
 *                        gasLimit, to, value, data, accessList])
 *
 * This is the payload that gets signed by the MPC (keccak256 of this is the signing hash).
 *
 * @returns Uint8Array containing the unsigned serialized transaction (type 2 prefix + RLP)
 */
export function buildUnsignedEip1559Tx(params: EvmTxParams): Uint8Array {
  const accessList = params.accessList ?? [];

  const rlpData = rlpEncodeList([
    bigintToRlpBytes(params.chainId),
    bigintToRlpBytes(params.nonce),
    bigintToRlpBytes(params.maxPriorityFeePerGas),
    bigintToRlpBytes(params.maxFeePerGas),
    bigintToRlpBytes(params.gasLimit),
    params.to,
    bigintToRlpBytes(params.value),
    params.data,
    accessList.map(([addr, storageKeys]) => [addr, ...storageKeys]),
  ]);

  // EIP-1559 type prefix (0x02) + RLP payload
  const result = new Uint8Array(1 + rlpData.length);
  result[0] = 0x02;
  result.set(rlpData, 1);
  return result;
}

/**
 * Build ERC20 transfer calldata: transfer(address to, uint256 amount)
 *
 * Function selector: 0xa9059cbb
 */
export function buildErc20TransferData(to: Uint8Array, amount: bigint): Uint8Array {
  const data = new Uint8Array(4 + 32 + 32);
  // Function selector: transfer(address,uint256)
  data[0] = 0xa9;
  data[1] = 0x05;
  data[2] = 0x9c;
  data[3] = 0xbb;
  // address (left-padded to 32 bytes)
  data.set(to, 4 + (32 - to.length));
  // uint256 amount (big-endian, 32 bytes)
  const amountBytes = bigintToBytes32(amount);
  data.set(amountBytes, 4 + 32);
  return data;
}

// ---- RLP Encoding (minimal, no external dependencies) ----

type RlpInput = Uint8Array | RlpInput[];

/** RLP-encode a single byte string. */
function rlpEncodeBytes(data: Uint8Array): Uint8Array {
  if (data.length === 1 && data[0] < 0x80) {
    return data;
  }
  if (data.length <= 55) {
    const result = new Uint8Array(1 + data.length);
    result[0] = 0x80 + data.length;
    result.set(data, 1);
    return result;
  }
  const lenBytes = encodeLengthBE(data.length);
  const result = new Uint8Array(1 + lenBytes.length + data.length);
  result[0] = 0xb7 + lenBytes.length;
  result.set(lenBytes, 1);
  result.set(data, 1 + lenBytes.length);
  return result;
}

/** RLP-encode a list of items. */
function rlpEncodeList(items: RlpInput[]): Uint8Array {
  const encoded = items.map((item) => rlpEncode(item));
  const totalLen = encoded.reduce((sum, e) => sum + e.length, 0);

  if (totalLen <= 55) {
    const result = new Uint8Array(1 + totalLen);
    result[0] = 0xc0 + totalLen;
    let offset = 1;
    for (const e of encoded) {
      result.set(e, offset);
      offset += e.length;
    }
    return result;
  }

  const lenBytes = encodeLengthBE(totalLen);
  const result = new Uint8Array(1 + lenBytes.length + totalLen);
  result[0] = 0xf7 + lenBytes.length;
  result.set(lenBytes, 1);
  let offset = 1 + lenBytes.length;
  for (const e of encoded) {
    result.set(e, offset);
    offset += e.length;
  }
  return result;
}

/** RLP-encode an item (bytes or nested list). */
function rlpEncode(input: RlpInput): Uint8Array {
  if (input instanceof Uint8Array) {
    return rlpEncodeBytes(input);
  }
  return rlpEncodeList(input);
}

/** Encode an integer as minimal big-endian bytes. */
function encodeLengthBE(n: number): Uint8Array {
  if (n <= 0xff) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
  if (n <= 0xffffff) return new Uint8Array([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  return new Uint8Array([(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

/** Convert a bigint to minimal RLP-compatible bytes (big-endian, no leading zeros). */
function bigintToRlpBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0);
  const hex = n.toString(16);
  const padded = hex.length % 2 === 0 ? hex : '0' + hex;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Convert a bigint to exactly 32 bytes (big-endian). */
function bigintToBytes32(n: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}
