// The java-tron HTTP calls a Tron request's client makes around the MPC: the reference block to
// build a request on, the broadcast of the signed transaction, and the final receipt. Reads go to
// the solidity router (`/walletsolidity/...`), the finality the MPC itself reads, so the client
// sees what the MPC will attest.

import type { JsonValue } from "./abi-serde.ts";
import { bytesToHex, hexToBytes } from "./byte-codecs.ts";
import { redactUrlQuery } from "./url-redaction.ts";

async function tronNodePost(rpcUrl: string, path: string, body: object): Promise<string> {
  const url = `${rpcUrl.replace(/\/+$/, "")}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Tron node ${redactUrlQuery(url)} answered HTTP ${String(response.status)}: ${text}`,
    );
  }
  return text;
}

/** The TaPoS reference fields of a Tron transaction, naming the block it is built on. */
export interface TronTaposReference {
  /** Bytes 6..8 of the block number, big-endian: the number modulo 65536. */
  readonly refBlockBytes: Uint8Array;
  /** Bytes 8..16 of the block id. */
  readonly refBlockHash: Uint8Array;
}

/**
 * The TaPoS reference to a block, as java-tron builds it and the MPC resolves it.
 *
 * @param blockNumber - The block's number
 * @param blockId - The block's 32-byte id
 * @returns The reference fields
 * @throws {Error} If the block id is not 32 bytes or the number does not fit 64 bits
 */
export function tronTaposReference(blockNumber: bigint, blockId: Uint8Array): TronTaposReference {
  if (blockId.length !== 32) {
    throw new Error(`a Tron block id is 32 bytes, got ${String(blockId.length)}`);
  }
  if (blockNumber < 0n || blockNumber >= 2n ** 64n) {
    throw new Error(`Tron block number ${String(blockNumber)} does not fit 64 bits`);
  }
  const number = new Uint8Array(8);
  new DataView(number.buffer).setBigUint64(0, blockNumber);
  return { refBlockBytes: number.slice(6, 8), refBlockHash: blockId.slice(8, 16) };
}

/** A solidified block a request can reference, with the time its timestamp field should follow. */
export interface TronReferenceBlock extends TronTaposReference {
  readonly number: bigint;
  readonly blockId: Uint8Array;
  /** The block's timestamp in milliseconds. */
  readonly timestamp: bigint;
}

interface NowBlockAnswer {
  readonly blockID?: string;
  readonly block_header?: { readonly raw_data?: { readonly number?: number; timestamp?: number } };
}

/**
 * The solidified head (`/walletsolidity/getnowblock`) as a reference block. A solidified block
 * cannot be reorganised away, so a transaction referencing it stays includable until it expires;
 * one referencing an unsolidified head can name a block the chain drops, which the MPC signs but
 * never answers.
 *
 * @param rpcUrl - The java-tron HTTP API base URL
 * @returns The solidified head and its TaPoS reference
 * @throws {Error} If the node cannot be reached or answers without a block
 */
export async function getSolidifiedTronReferenceBlock(rpcUrl: string): Promise<TronReferenceBlock> {
  const answer = JSON.parse(
    await tronNodePost(rpcUrl, "/walletsolidity/getnowblock", {}),
  ) as NowBlockAnswer;
  const raw = answer.block_header?.raw_data;
  if (answer.blockID === undefined || raw?.number === undefined || raw.timestamp === undefined) {
    throw new Error("Tron /walletsolidity/getnowblock answered no block id, number or timestamp");
  }
  const number = BigInt(raw.number);
  const blockId = hexToBytes(answer.blockID);
  return {
    ...tronTaposReference(number, blockId),
    number,
    blockId,
    timestamp: BigInt(raw.timestamp),
  };
}

/** How the node took a broadcast it did not refuse. */
export enum TronBroadcastOutcome {
  /** The node accepted the transaction now. */
  Accepted,
  /**
   * `DUP_TRANSACTION_ERROR`: the node already holds a transaction with this id, so an earlier
   * broadcast (by anyone: the bytes are the same) reached it.
   */
  AlreadyKnown,
}

interface BroadcastAnswer {
  readonly result?: boolean;
  readonly code?: string;
  readonly message?: string;
}

// java-tron hex-encodes the ASCII message of some refusals.
function decodeTronMessage(message: string): string {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(message)) return message;
  const bytes = hexToBytes(message);
  return bytes.every((byte) => byte >= 0x20 && byte < 0x7f)
    ? new TextDecoder().decode(bytes)
    : message;
}

/**
 * Broadcasts a signed transaction (`/wallet/broadcasthex`). A duplicate is not an error: the
 * signed bytes are public once the MPC posts the signature, so another client may have sent them.
 *
 * @param rpcUrl - The java-tron HTTP API base URL
 * @param signedTransaction - The signed `Transaction` protobuf bytes
 * @returns Whether this call submitted it or the node already had it
 * @throws {Error} If the node refuses it (for example `TRANSACTION_EXPIRATION_ERROR` once its
 *   expiration has passed, or `SERVER_BUSY`, which a caller may retry with the same bytes)
 */
export async function broadcastTronTransaction(
  rpcUrl: string,
  signedTransaction: Uint8Array,
): Promise<TronBroadcastOutcome> {
  const answer = JSON.parse(
    await tronNodePost(rpcUrl, "/wallet/broadcasthex", {
      transaction: bytesToHex(signedTransaction),
    }),
  ) as BroadcastAnswer;
  if (answer.result === true) return TronBroadcastOutcome.Accepted;
  if (answer.code === "DUP_TRANSACTION_ERROR") return TronBroadcastOutcome.AlreadyKnown;
  throw new Error(
    `Tron node refused the transaction: ${answer.code ?? "no code"}: ` +
      decodeTronMessage(answer.message ?? ""),
  );
}

/** A final (solidified) Tron transaction receipt: what the MPC attests from. */
export interface TronTransactionReceipt {
  readonly id: Uint8Array;
  readonly blockNumber: bigint;
  /** The block's timestamp in milliseconds. */
  readonly blockTimestamp: bigint;
  /** The total fee in sun. */
  readonly fee: bigint;
  /** `TransactionInfo.code`: java-tron prints it only on failure (`FAILED`). */
  readonly result: string | undefined;
  /** `receipt.result`, the VM's contract result (`SUCCESS`, `REVERT`, `OUT_OF_ENERGY`, ...). */
  readonly receiptResult: string | undefined;
  /** The top call's return data, the output the MPC attests. */
  readonly contractResult: readonly Uint8Array[];
  /** The node's answer as is, for `evmTraceOutputFromTronReceipt`. */
  readonly body: JsonValue;
}

interface TransactionInfoAnswer {
  readonly id?: string;
  readonly blockNumber?: number;
  readonly blockTimeStamp?: number;
  readonly fee?: number;
  readonly result?: string;
  readonly receipt?: { readonly result?: string };
  readonly contractResult?: readonly string[];
}

/**
 * The final receipt of a transaction (`/walletsolidity/gettransactioninfobyid`).
 *
 * @param rpcUrl - The java-tron HTTP API base URL
 * @param txId - The 32-byte transaction id
 * @returns The receipt, or `undefined` while the transaction is not in a solidified block
 * @throws {Error} If the node cannot be reached or answers a malformed receipt
 */
export async function getSolidifiedTronTransactionInfo(
  rpcUrl: string,
  txId: Uint8Array,
): Promise<TronTransactionReceipt | undefined> {
  const body = JSON.parse(
    await tronNodePost(rpcUrl, "/walletsolidity/gettransactioninfobyid", {
      value: bytesToHex(txId),
    }),
  ) as JsonValue;
  const answer = body as TransactionInfoAnswer;
  if (answer.id === undefined) return undefined;
  if (answer.blockNumber === undefined || answer.blockTimeStamp === undefined) {
    throw new Error(`Tron receipt ${answer.id} names no block`);
  }
  return {
    id: hexToBytes(answer.id),
    blockNumber: BigInt(answer.blockNumber),
    blockTimestamp: BigInt(answer.blockTimeStamp),
    fee: BigInt(answer.fee ?? 0),
    result: answer.result,
    receiptResult: answer.receipt?.result,
    contractResult: (answer.contractResult ?? []).map((data) => hexToBytes(data)),
    body,
  };
}
