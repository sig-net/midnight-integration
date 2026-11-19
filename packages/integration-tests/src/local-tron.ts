import type { TronTxWindow } from "@midnight-integration/test-caller-contract";
import {
  bytesToHex,
  hexToBytes,
  type JsonValue,
  stripHexPrefix,
  tronAddressFromEvm,
  tronAddressToBase58,
  tronTransactionId,
} from "@sig-net/midnight";
import { computeAddress, concat, getBytes, SigningKey, toBeHex } from "ethers";

import { pollUntilDefined } from "./poll.ts";

const SECOND = 1000;

const REQUEST_TIMEOUT_MS = 30 * SECOND;

/**
 * The Tron HTTP API base URL from the env, defaulting to the local TRE.
 *
 * @param env - The suite's env accumulator
 * @returns The HTTP API base URL
 */
export function tronRpcUrl(env: NodeJS.ProcessEnv): string {
  return env.TRON_RPC_URL ?? "http://127.0.0.1:9090";
}

const TRE_FUNDER_KEY = new SigningKey(
  "0x0000000000000000000000000000000000000000000000000000000000000001",
);

/** The 21-byte address of TRE's dev funder account (private key 0x00…01). */
export const TRE_FUNDER_ADDRESS = tronAddressFromEvm(computeAddress(TRE_FUNDER_KEY.publicKey));

async function tronPost<T>(
  rpcUrl: string,
  path: string,
  body: object,
  stop?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${rpcUrl.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.any([
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(stop === undefined ? [] : [stop]),
    ]),
  });
  if (!response.ok) {
    throw new Error(
      `${path}: HTTP ${String(response.status)} from ${rpcUrl}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

/**
 * Check that the endpoint is a ready local TRE whose dev funder holds TRX.
 *
 * @param rpcUrl - The HTTP API base URL to probe
 * @throws {Error} If the endpoint is unreachable, is not a ready TRE, or its dev funder account holds no TRX
 */
export async function assertLocalTre(rpcUrl: string): Promise<void> {
  const url = `${rpcUrl.replace(/\/+$/, "")}/admin/accounts`;
  let page: string;
  try {
    page = await (await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })).text();
  } catch (error) {
    throw new Error(
      `Tron endpoint ${rpcUrl} is unreachable: start the \`tron\` docker compose service (TRE)`,
      { cause: error },
    );
  }
  if (!page.includes("Available Accounts")) {
    throw new Error(
      `${url} lists no dev accounts: the e2e's dev-funder actions (deploy, funding) only run ` +
        `against a local TRE, and a starting TRE serves the list once its accounts are funded`,
    );
  }
  if ((await getTrxBalance(rpcUrl, TRE_FUNDER_ADDRESS)) === 0n) {
    throw new Error(
      `TRE's dev funder ${tronAddressToBase58(TRE_FUNDER_ADDRESS)} (private key 0x00…01) holds ` +
        `no TRX: run TRE with useDefaultPrivateKey=true (the compose \`tron\` service does)`,
    );
  }
}

interface TronBlockJson {
  blockID?: string;
  block_header?: { raw_data: { number?: number; timestamp?: number } };
}

/** A Tron block's height, id and timestamp. */
export interface TronBlockRef {
  number: bigint;
  id: Uint8Array;
  timestamp: bigint;
}

function tronBlockRef(block: TronBlockJson, what: string): TronBlockRef {
  if (block.blockID === undefined || block.block_header === undefined) {
    throw new Error(`${what}: the node returned no block`);
  }
  const { number, timestamp } = block.block_header.raw_data;
  return {
    number: BigInt(number ?? 0),
    id: hexToBytes(block.blockID),
    timestamp: BigInt(timestamp ?? 0),
  };
}

/**
 * Read the node's head block.
 *
 * @param rpcUrl - The HTTP API base URL
 * @returns The head block's identity
 */
export async function getTronHeadBlock(rpcUrl: string): Promise<TronBlockRef> {
  return tronBlockRef(
    await tronPost<TronBlockJson>(rpcUrl, "/wallet/getnowblock", {}),
    "/wallet/getnowblock",
  );
}

/**
 * Wait until the node's head block is no older than `maxAgeMs`.
 *
 * @param rpcUrl - The HTTP API base URL
 * @param maxAgeMs - The largest acceptable head age, milliseconds
 * @param timeoutMs - How long to wait for a fresh head
 * @returns The fresh head block's identity
 * @throws {Error} When the head stays stale past `timeoutMs`
 */
export async function waitForFreshTronHead(
  rpcUrl: string,
  maxAgeMs: number,
  timeoutMs: number,
): Promise<TronBlockRef> {
  const seen: { head?: TronBlockRef } = {};
  const fresh = await pollUntilDefined(
    async () => {
      const head = await getTronHeadBlock(rpcUrl);
      seen.head = head;
      return BigInt(Date.now()) - head.timestamp <= BigInt(maxAgeMs) ? head : undefined;
    },
    timeoutMs,
    SECOND,
  );
  if (fresh === undefined) {
    throw new Error(
      `the Tron head (block ${String(seen.head?.number)} at ${String(seen.head?.timestamp)}) ` +
        `stayed more than ${String(maxAgeMs)}ms behind the wall clock for ${String(timeoutMs)}ms`,
    );
  }
  return fresh;
}

/**
 * Read the node's solidified head block.
 *
 * @param rpcUrl - The HTTP API base URL
 * @returns The solidified head block's identity
 */
export async function getSolidifiedTronHeadBlock(rpcUrl: string): Promise<TronBlockRef> {
  return tronBlockRef(
    await tronPost<TronBlockJson>(rpcUrl, "/walletsolidity/getnowblock", {}),
    "/walletsolidity/getnowblock",
  );
}

/**
 * Read a solidified block by height.
 *
 * @param rpcUrl - The HTTP API base URL
 * @param number - The block height
 * @returns The block identity, or `undefined` when that height is not solidified yet
 */
export async function getSolidifiedTronBlock(
  rpcUrl: string,
  number: bigint,
): Promise<TronBlockRef | undefined> {
  const block = await tronPost<TronBlockJson>(rpcUrl, "/walletsolidity/getblockbynum", {
    num: Number(number),
  });
  return block.blockID === undefined
    ? undefined
    : tronBlockRef(block, `solidified block ${String(number)}`);
}

/**
 * Build the TaPoS reference, timestamp, expiration and fee limit of a transaction from its reference block.
 *
 * @param reference - The referenced block
 * @param validityMs - Milliseconds from the timestamp to the expiration
 * @param feeLimit - The energy fee ceiling, sun
 * @returns The window the caller's Tron submit circuits take
 */
export function tronTxWindowFromBlock(
  reference: TronBlockRef,
  validityMs: bigint,
  feeLimit: bigint,
): TronTxWindow {
  return {
    refBlockBytes: getBytes(toBeHex(reference.number & 0xffffn, 2)),
    refBlockHash: reference.id.slice(8, 16),
    timestamp: reference.timestamp,
    expiration: reference.timestamp + validityMs,
    feeLimit,
  };
}

/**
 * Find the first solidified block after the reference block whose timestamp reaches the expiration.
 *
 * @param rpcUrl - The HTTP API base URL
 * @param referenceNumber - The height the transaction's TaPoS fields name
 * @param expiration - The transaction's expiration, milliseconds
 * @returns The boundary block's height
 * @throws {Error} If a block on the way is not solidified yet
 */
export async function findSolidifiedExpiryBoundary(
  rpcUrl: string,
  referenceNumber: bigint,
  expiration: bigint,
): Promise<bigint> {
  for (let height = referenceNumber + 1n; ; height++) {
    const block = await getSolidifiedTronBlock(rpcUrl, height);
    if (block === undefined) {
      throw new Error(
        `solidified block ${String(height)} is absent before any block reached ` +
          `expiration ${String(expiration)}`,
      );
    }
    if (block.timestamp >= expiration) {
      return height;
    }
  }
}

/** The fields of a node's transaction receipt the e2e reads. */
export interface TronTransactionInfo {
  id: string;
  blockNumber: number;
  result?: string;
  resMessage?: string;
  receipt?: { result?: string };
  contractResult?: string[];
}

/**
 * Read a transaction's receipt from the solidified chain.
 *
 * @param rpcUrl - The HTTP API base URL
 * @param txid - The 32-byte transaction id
 * @returns The receipt, or `undefined` while the transaction is not in a solidified block
 */
export async function getSolidifiedTransactionInfo(
  rpcUrl: string,
  txid: Uint8Array,
): Promise<TronTransactionInfo | undefined> {
  const info = await tronPost<Partial<TronTransactionInfo>>(
    rpcUrl,
    "/walletsolidity/gettransactioninfobyid",
    { value: bytesToHex(txid) },
  );
  return info.id === undefined ? undefined : (info as TronTransactionInfo);
}

/**
 * Wait until a transaction's receipt is in a solidified block.
 *
 * @param rpcUrl - The HTTP API base URL
 * @param txid - The 32-byte transaction id
 * @param timeoutMs - How long to keep polling
 * @returns The receipt
 * @throws {Error} When no receipt solidifies within `timeoutMs`
 */
export async function waitForSolidifiedTransactionInfo(
  rpcUrl: string,
  txid: Uint8Array,
  timeoutMs: number,
): Promise<TronTransactionInfo> {
  const info = await pollUntilDefined(
    () => getSolidifiedTransactionInfo(rpcUrl, txid),
    timeoutMs,
    SECOND,
  );
  if (info === undefined) {
    throw new Error(
      `transaction ${bytesToHex(txid)} did not solidify within ${String(timeoutMs)}ms`,
    );
  }
  return info;
}

/** How the node took a broadcast it did not refuse. */
export enum TronBroadcastOutcome {
  Accepted = "accepted",
  AlreadyKnown = "already-known",
}

interface TronBroadcastReply {
  result?: boolean;
  code?: string;
  message?: string;
}

function broadcastOutcome(reply: TronBroadcastReply, what: string): TronBroadcastOutcome {
  if (reply.result === true) {
    return TronBroadcastOutcome.Accepted;
  }
  if (reply.code === "DUP_TRANSACTION_ERROR") {
    return TronBroadcastOutcome.AlreadyKnown;
  }
  const message =
    reply.message !== undefined && /^([0-9a-fA-F]{2})*$/.test(reply.message)
      ? Buffer.from(reply.message, "hex").toString("utf8")
      : reply.message;
  throw new Error(`${what} refused: ${reply.code ?? "no code"} ${message ?? ""}`.trim());
}

/**
 * Broadcast a signed transaction, unless it already solidified, and wait for its solidified receipt.
 *
 * @param rpcUrl - The HTTP API base URL
 * @param signedTransaction - The signed protobuf `Transaction` bytes
 * @param txid - The transaction's id (sha256 of its raw bytes)
 * @param timeoutMs - How long to wait for the receipt
 * @returns The solidified receipt, whatever the execution's result
 * @throws {Error} When the node refuses the transaction or no receipt solidifies in time
 */
export async function broadcastSignedTronTransaction(
  rpcUrl: string,
  signedTransaction: Uint8Array,
  txid: Uint8Array,
  timeoutMs: number,
): Promise<TronTransactionInfo> {
  const solidified = await getSolidifiedTransactionInfo(rpcUrl, txid);
  if (solidified !== undefined) {
    console.log(`already solidified at block ${String(solidified.blockNumber)}`);
    return solidified;
  }
  const outcome = broadcastOutcome(
    await tronPost<TronBroadcastReply>(rpcUrl, "/wallet/broadcasthex", {
      transaction: bytesToHex(signedTransaction),
    }),
    `broadcast of ${bytesToHex(txid)}`,
  );
  console.log(`broadcast ${bytesToHex(txid)} (${outcome}), waiting for its solidified receipt…`);
  return waitForSolidifiedTransactionInfo(rpcUrl, txid, timeoutMs);
}

interface TronNodeTransaction {
  txID: string;
  raw_data_hex: string;
  raw_data: JsonValue;
  visible?: boolean;
  contract_address?: string;
}

type TronNodeBuildReply = Partial<TronNodeTransaction> & { Error?: string };

function signNodeTransaction(
  reply: TronNodeBuildReply,
  what: string,
): { signed: TronNodeTransaction & { signature: string[] }; txid: Uint8Array } {
  const { txID, raw_data_hex: rawHex, raw_data: rawData } = reply;
  if (txID === undefined || rawHex === undefined || rawData === undefined) {
    throw new Error(`${what}: the node built no transaction (${reply.Error ?? "no error given"})`);
  }
  const txid = tronTransactionId(hexToBytes(rawHex));
  if (bytesToHex(txid) !== stripHexPrefix(txID).toLowerCase()) {
    throw new Error(`${what}: the node's txID is not sha256 of its raw bytes`);
  }
  const signature = TRE_FUNDER_KEY.sign(txid);
  const signatureHex = stripHexPrefix(
    concat([signature.r, signature.s, toBeHex(signature.yParity, 1)]),
  );
  return {
    signed: { ...reply, txID, raw_data_hex: rawHex, raw_data: rawData, signature: [signatureHex] },
    txid,
  };
}

async function broadcastNodeTransaction(
  rpcUrl: string,
  reply: TronNodeBuildReply,
  what: string,
  stop?: AbortSignal,
): Promise<Uint8Array> {
  const { signed, txid } = signNodeTransaction(reply, what);
  broadcastOutcome(
    await tronPost<TronBroadcastReply>(rpcUrl, "/wallet/broadcasttransaction", signed, stop),
    what,
  );
  return txid;
}

/**
 * Send TRX from TRE's dev funder, without waiting for the transfer to land.
 *
 * @param rpcUrl - The HTTP API base URL of the LOCAL TRE
 * @param to - The 21-byte recipient address
 * @param amount - The amount, sun
 * @param stop - Aborts the transfer's requests when it fires
 * @returns The transfer's transaction id
 */
export async function sendTrxFromFunder(
  rpcUrl: string,
  to: Uint8Array,
  amount: bigint,
  stop?: AbortSignal,
): Promise<Uint8Array> {
  return broadcastNodeTransaction(
    rpcUrl,
    await tronPost<TronNodeBuildReply>(
      rpcUrl,
      "/wallet/createtransaction",
      {
        owner_address: bytesToHex(TRE_FUNDER_ADDRESS),
        to_address: bytesToHex(to),
        amount: Number(amount),
        visible: false,
      },
      stop,
    ),
    `TRX transfer of ${String(amount)} sun to ${bytesToHex(to)}`,
    stop,
  );
}

/**
 * Read an account's TRX balance.
 *
 * @param rpcUrl - The HTTP API base URL
 * @param address - The 21-byte account address
 * @returns The balance in sun, 0 for an account that does not exist yet
 */
export async function getTrxBalance(rpcUrl: string, address: Uint8Array): Promise<bigint> {
  const account = await tronPost<{ balance?: number }>(rpcUrl, "/wallet/getaccount", {
    address: bytesToHex(address),
    visible: false,
  });
  return BigInt(account.balance ?? 0);
}

/**
 * Fund an account from TRE's dev funder up to a target balance.
 *
 * @param rpcUrl - The HTTP API base URL of the LOCAL TRE
 * @param address - The 21-byte account to top up
 * @param target - The balance to reach, sun
 * @returns The account's balance after the top-up
 */
export async function topUpTrx(
  rpcUrl: string,
  address: Uint8Array,
  target: bigint,
): Promise<bigint> {
  const balance = await getTrxBalance(rpcUrl, address);
  if (balance >= target) {
    return balance;
  }
  const txid = await sendTrxFromFunder(rpcUrl, address, target - balance);
  await waitForSolidifiedTransactionInfo(rpcUrl, txid, 2 * 60 * SECOND);
  return getTrxBalance(rpcUrl, address);
}

/** The parts of a compiled Solidity artifact a Tron deploy needs. */
export interface TronContractArtifact {
  contractName: string;
  abi: JsonValue;
  bytecode: string;
}

/**
 * Deploy a compiled contract from TRE's dev funder and wait for it to solidify.
 *
 * @param rpcUrl - The HTTP API base URL of the LOCAL TRE
 * @param artifact - The compiled contract to deploy
 * @returns The deployed contract's 21-byte address
 * @throws {Error} If the node refuses the deploy or its execution fails
 */
export async function deployTronContract(
  rpcUrl: string,
  artifact: TronContractArtifact,
): Promise<Uint8Array> {
  const build = await tronPost<TronNodeBuildReply>(rpcUrl, "/wallet/deploycontract", {
    owner_address: bytesToHex(TRE_FUNDER_ADDRESS),
    name: artifact.contractName,
    abi: JSON.stringify(artifact.abi),
    bytecode: stripHexPrefix(artifact.bytecode),
    parameter: "",
    call_value: 0,
    fee_limit: 1_000_000_000,
    consume_user_resource_percent: 100,
    origin_energy_limit: 10_000_000,
    visible: false,
  });
  if (build.contract_address === undefined) {
    throw new Error(
      `deploy of ${artifact.contractName}: the node named no contract address ` +
        `(${build.Error ?? "no error given"})`,
    );
  }
  const address = hexToBytes(build.contract_address);
  const txid = await broadcastNodeTransaction(rpcUrl, build, `deploy of ${artifact.contractName}`);
  const info = await waitForSolidifiedTransactionInfo(rpcUrl, txid, 2 * 60 * SECOND);
  if (info.receipt?.result !== "SUCCESS") {
    throw new Error(
      `deploy of ${artifact.contractName} executed ${info.receipt?.result ?? "without a result"}`,
    );
  }
  return address;
}

/**
 * Check whether an address holds contract code.
 *
 * @param rpcUrl - The HTTP API base URL
 * @param address - The 21-byte address to probe
 * @returns `true` when code is present
 */
export async function hasTronContractCode(rpcUrl: string, address: Uint8Array): Promise<boolean> {
  const contract = await tronPost<{ bytecode?: string }>(rpcUrl, "/wallet/getcontract", {
    value: bytesToHex(address),
    visible: false,
  });
  return (contract.bytecode ?? "").length > 0;
}
