// Local-Tron (TRE) plumbing for the Tron signet-caller e2e: java-tron HTTP
// API reads (blocks, solidified receipts, balances, contract code), the
// TaPoS window a Tron request is signed over, node-built transactions signed
// by TRE's dev funder account (contract deploy, TRX transfers), and
// idempotent broadcast of an MPC-signed transaction. The dev funder only
// exists pre-funded on a throwaway TRE chain, so the setup gates every
// funder action on assertLocalTre.
//
// TRE produces a block only when a transaction arrives, so every wait on a
// solidified receipt or an expiry runs inside withTronBlockPusher
// (tron-block-pusher.ts), which keeps the chain moving.

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

const SECOND = 1000;

/**
 * The tests' host-side Tron endpoint: `TRON_RPC_URL`, defaulting to the
 * `tron` docker compose service's host mapping. The java-tron HTTP API of
 * TRE: full node (`/wallet/*`) and solidity node (`/walletsolidity/*`)
 * routes on one port.
 *
 * @param env - The suite's env accumulator.
 * @returns The HTTP API base URL.
 */
export function tronRpcUrl(env: NodeJS.ProcessEnv): string {
  return env.TRON_RPC_URL ?? "http://127.0.0.1:9090";
}

// TRE's deterministic dev account (`useDefaultPrivateKey=true`): private key
// 0x00…01, pre-funded on every fresh TRE, never funded on a real Tron
// network. Deployer of the test target, source of top-ups and of the block
// pusher's filler transfers.
const TRE_FUNDER_KEY = new SigningKey(
  "0x0000000000000000000000000000000000000000000000000000000000000001",
);

/** The 21-byte Tron address of TRE's dev funder account. */
export const TRE_FUNDER_ADDRESS = tronAddressFromEvm(computeAddress(TRE_FUNDER_KEY.publicKey));

/**
 * POST a JSON body to one java-tron HTTP API route and parse the JSON reply.
 *
 * @param rpcUrl - The HTTP API base URL.
 * @param path - The route, e.g. `/wallet/getnowblock`.
 * @param body - The request body.
 * @returns The parsed reply, typed by the caller to the route's documented shape.
 * @throws {Error} When the node answers a non-2xx status.
 */
async function tronPost<T>(rpcUrl: string, path: string, body: object): Promise<T> {
  const response = await fetch(`${rpcUrl.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `${path}: HTTP ${String(response.status)} from ${rpcUrl}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

/**
 * Assert `rpcUrl` is a local TRE chain whose dev funder holds TRX: the gate
 * on every dev-funder-signed action in this module. TRE alone serves
 * `/admin/accounts`, the page that lists its pre-funded dev accounts, and
 * serves it only once their funding has landed.
 *
 * @param rpcUrl - The HTTP API base URL to probe.
 * @throws {Error} If the endpoint is unreachable, is not a ready TRE, or
 *   its dev funder account holds no TRX.
 */
export async function assertLocalTre(rpcUrl: string): Promise<void> {
  const url = `${rpcUrl.replace(/\/+$/, "")}/admin/accounts`;
  let page: string;
  try {
    page = await (await fetch(url)).text();
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

/** A block as java-tron's HTTP API renders it (the fields this module reads). */
interface TronBlockJson {
  /** The block id, 64 hex digits; absent in the `{}` an unknown block number returns. */
  blockID?: string;
  /** The header; proto3 omits a zero `number` (genesis). */
  block_header?: { raw_data: { number?: number; timestamp?: number } };
}

/** The identity of a Tron block: what a TaPoS reference and an expiry oracle read. */
export interface TronBlockRef {
  /** The block height. */
  number: bigint;
  /** The 32-byte block id. */
  id: Uint8Array;
  /** The block timestamp, milliseconds. */
  timestamp: bigint;
}

/**
 * Parse a block reply into its identity.
 *
 * @param block - The reply.
 * @param what - Error-message subject.
 * @returns The block identity.
 * @throws {Error} If the reply carries no block id or header.
 */
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
 * The full node's current head block: the reference a fresh transaction's
 * TaPoS fields name.
 *
 * @param rpcUrl - The HTTP API base URL.
 * @returns The head block's identity.
 */
export async function getTronHeadBlock(rpcUrl: string): Promise<TronBlockRef> {
  return tronBlockRef(
    await tronPost<TronBlockJson>(rpcUrl, "/wallet/getnowblock", {}),
    "/wallet/getnowblock",
  );
}

/**
 * Wait until the head block is at most `maxAgeMs` behind the wall clock and
 * return it: the reference a transaction about to be signed should name. An
 * idle TRE's head can be hours old, and a validity window counted from it
 * may already lie behind the time of the next block, so the e2e counts its
 * windows from a head the pusher has just refreshed. Run inside
 * `withTronBlockPusher`.
 *
 * @param rpcUrl - The HTTP API base URL.
 * @param maxAgeMs - The largest acceptable head age, milliseconds.
 * @param timeoutMs - How long to wait for a fresh head.
 * @returns The fresh head block's identity.
 * @throws {Error} When the head stays stale past `timeoutMs`.
 */
export async function waitForFreshTronHead(
  rpcUrl: string,
  maxAgeMs: number,
  timeoutMs: number,
): Promise<TronBlockRef> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const head = await getTronHeadBlock(rpcUrl);
    if (BigInt(Date.now()) - head.timestamp <= BigInt(maxAgeMs)) {
      return head;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the Tron head (block ${String(head.number)} at ${String(head.timestamp)}) stayed more ` +
          `than ${String(maxAgeMs)}ms behind the wall clock for ${String(timeoutMs)}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, SECOND));
  }
}

/**
 * The solidity node's current head: the newest block the MPC reads.
 *
 * @param rpcUrl - The HTTP API base URL.
 * @returns The solidified head block's identity.
 */
export async function getSolidifiedTronHeadBlock(rpcUrl: string): Promise<TronBlockRef> {
  return tronBlockRef(
    await tronPost<TronBlockJson>(rpcUrl, "/walletsolidity/getnowblock", {}),
    "/walletsolidity/getnowblock",
  );
}

/**
 * One solidified block by height, read from the solidity node.
 *
 * @param rpcUrl - The HTTP API base URL.
 * @param number - The block height.
 * @returns The block identity, or `undefined` when that height is not
 *   solidified yet.
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
 * The TaPoS window of a Tron transaction referencing `reference`: its
 * height's low two bytes and bytes 8..16 of its id, the block's timestamp as
 * the transaction's, and an expiration `validityMs` later. Tron accepts a
 * transaction only while its expiration is ahead of the head block's time,
 * and the MPC attests a never-included one unviable once the solidified
 * chain passes it.
 *
 * @param reference - The referenced block.
 * @param validityMs - Milliseconds from the timestamp to the expiration.
 * @param feeLimit - The energy fee ceiling, sun.
 * @returns The window the caller's Tron submit circuits take.
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
 * Find the first solidified block at or past `expiration`, scanning up from
 * the block after the reference: the height the MPC attests a never-included
 * transaction unviable at. An oracle independent of the attestation, so the
 * scan reads every block rather than trusting the posted height.
 *
 * @param rpcUrl - The HTTP API base URL.
 * @param referenceNumber - The height the transaction's TaPoS fields name.
 * @param expiration - The transaction's expiration, milliseconds.
 * @returns The boundary block's height.
 * @throws {Error} If a block on the way is not solidified yet.
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

/**
 * The receipt of a transaction as `/walletsolidity/gettransactioninfobyid`
 * renders it (the fields this module reads).
 */
export interface TronTransactionInfo {
  /** The transaction id, 64 hex digits. */
  id: string;
  /** The solidified block holding the transaction. */
  blockNumber: number;
  /** `FAILED` when the execution failed; absent on success. */
  result?: string;
  /** Why the execution failed, hex-encoded UTF-8. */
  resMessage?: string;
  /** The contract-execution receipt; `result` is absent for a plain transfer. */
  receipt?: { result?: string };
}

/**
 * The solidified receipt of a transaction, if it has one yet.
 *
 * @param rpcUrl - The HTTP API base URL.
 * @param txid - The 32-byte transaction id.
 * @returns The receipt, or `undefined` while the transaction is not in a
 *   solidified block.
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
 * Poll for a transaction's solidified receipt. Run inside
 * `withTronBlockPusher`: TRE solidifies nothing while it produces no blocks.
 *
 * @param rpcUrl - The HTTP API base URL.
 * @param txid - The 32-byte transaction id.
 * @param timeoutMs - How long to keep polling.
 * @returns The receipt.
 * @throws {Error} When no receipt solidifies within `timeoutMs`.
 */
export async function waitForSolidifiedTransactionInfo(
  rpcUrl: string,
  txid: Uint8Array,
  timeoutMs: number,
): Promise<TronTransactionInfo> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await getSolidifiedTransactionInfo(rpcUrl, txid);
    if (info !== undefined) {
      return info;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `transaction ${bytesToHex(txid)} did not solidify within ${String(timeoutMs)}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, SECOND));
  }
}

/** The outcome of a broadcast the node did not refuse. */
export enum TronBroadcastOutcome {
  /** The node accepted the transaction into its pending pool. */
  Accepted = "accepted",
  /** The node already holds this exact transaction. */
  AlreadyKnown = "already-known",
}

/** A broadcast reply (`/wallet/broadcasttransaction` and `/wallet/broadcasthex`). */
interface TronBroadcastReply {
  /** `true` when accepted. */
  result?: boolean;
  /** The refusal code, e.g. `DUP_TRANSACTION_ERROR` or `TRANSACTION_EXPIRATION_ERROR`. */
  code?: string;
  /** The refusal detail, hex-encoded UTF-8. */
  message?: string;
}

/**
 * Classify a broadcast reply, failing on a refusal.
 *
 * @param reply - The node's reply.
 * @param what - Error-message subject.
 * @returns Whether the node accepted the transaction or already held it.
 * @throws {Error} On any refusal other than a duplicate.
 */
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
 * Broadcast a signed Tron transaction as protobuf bytes, the form the MPC's
 * signature completes (see `getSignedTronTransaction`), and wait for its
 * solidified receipt. Idempotent: a transaction is content-addressed by its
 * id, so an existing receipt short-circuits and a duplicate broadcast falls
 * through to the wait. Run inside `withTronBlockPusher`.
 *
 * @param rpcUrl - The HTTP API base URL.
 * @param signedTransaction - The signed protobuf `Transaction` bytes.
 * @param txid - The transaction's id (sha256 of its raw bytes).
 * @param timeoutMs - How long to wait for the receipt.
 * @returns The solidified receipt, whatever the execution's result.
 * @throws {Error} When the node refuses the transaction (e.g. it expired)
 *   or no receipt solidifies in time.
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

/**
 * A transaction the node built (`/wallet/createtransaction`,
 * `/wallet/deploycontract`), in the JSON form `/wallet/broadcasttransaction`
 * takes back once signed.
 */
interface TronNodeTransaction {
  /** The transaction id: sha256 of `raw_data_hex`. */
  txID: string;
  /** The raw transaction bytes. */
  raw_data_hex: string;
  /** The raw transaction as JSON, echoed back on broadcast. */
  raw_data: JsonValue;
  /** Whether addresses render in base58. */
  visible?: boolean;
  /** The address a deployed contract will live at (deploys only), 0x41-prefixed hex. */
  contract_address?: string;
}

/** A node's transaction-building reply: the transaction, or why it refused. */
type TronNodeBuildReply = Partial<TronNodeTransaction> & { Error?: string };

/**
 * Check a node-built transaction against its id and sign it with TRE's dev
 * funder key: a 65-byte `r || s || recovery id` signature over the id.
 *
 * @param reply - The node's build reply.
 * @param what - Error-message subject.
 * @returns The transaction with its signature attached, and its id.
 * @throws {Error} If the node refused to build, or the id is not sha256 of
 *   the raw bytes.
 */
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

/**
 * Build, sign (dev funder) and broadcast a node-built transaction.
 *
 * @param rpcUrl - The HTTP API base URL.
 * @param reply - The node's build reply.
 * @param what - Error-message subject.
 * @returns The transaction id.
 * @throws {Error} If the build failed or the node refused the broadcast.
 */
async function broadcastNodeTransaction(
  rpcUrl: string,
  reply: TronNodeBuildReply,
  what: string,
): Promise<Uint8Array> {
  const { signed, txid } = signNodeTransaction(reply, what);
  broadcastOutcome(
    await tronPost<TronBroadcastReply>(rpcUrl, "/wallet/broadcasttransaction", signed),
    what,
  );
  return txid;
}

/**
 * Send TRX from TRE's dev funder account. Does not wait for inclusion.
 *
 * @param rpcUrl - The HTTP API base URL of the LOCAL TRE.
 * @param to - The 21-byte recipient address.
 * @param amount - The amount, sun.
 * @returns The transfer's transaction id.
 */
export async function sendTrxFromFunder(
  rpcUrl: string,
  to: Uint8Array,
  amount: bigint,
): Promise<Uint8Array> {
  return broadcastNodeTransaction(
    rpcUrl,
    await tronPost<TronNodeBuildReply>(rpcUrl, "/wallet/createtransaction", {
      owner_address: bytesToHex(TRE_FUNDER_ADDRESS),
      to_address: bytesToHex(to),
      amount: Number(amount),
      visible: false,
    }),
    `TRX transfer of ${String(amount)} sun to ${bytesToHex(to)}`,
  );
}

/**
 * An account's TRX balance.
 *
 * @param rpcUrl - The HTTP API base URL.
 * @param address - The 21-byte account address.
 * @returns The balance in sun, 0 for an account that does not exist yet.
 */
export async function getTrxBalance(rpcUrl: string, address: Uint8Array): Promise<bigint> {
  const account = await tronPost<{ balance?: number }>(rpcUrl, "/wallet/getaccount", {
    address: bytesToHex(address),
    visible: false,
  });
  return BigInt(account.balance ?? 0);
}

/**
 * Idempotent TRX top-up of one account on the local TRE: bring it to at
 * least `target` sun from the dev funder and wait until the transfer
 * solidifies. No-ops when the balance already meets the target. Run inside
 * `withTronBlockPusher`.
 *
 * @param rpcUrl - The HTTP API base URL of the LOCAL TRE.
 * @param address - The 21-byte account to top up.
 * @param target - The balance to reach, sun.
 * @returns The account's balance after the top-up.
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

/** The compiled-contract fields {@link deployTronContract} needs from a Solidity artifact. */
export interface TronContractArtifact {
  /** The contract name. */
  contractName: string;
  /** The contract's ABI. */
  abi: JsonValue;
  /** The deployment bytecode as 0x-hex. */
  bytecode: string;
}

/**
 * Deploy a compiled contract to the local TRE from the dev funder account,
 * through the node's `deploycontract` builder, and wait until the deploy
 * solidifies with a successful execution. Run inside `withTronBlockPusher`.
 *
 * @param rpcUrl - The HTTP API base URL of the LOCAL TRE.
 * @param artifact - The compiled contract to deploy.
 * @returns The deployed contract's 21-byte address.
 * @throws {Error} If the node refuses the deploy or its execution fails.
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
 * Whether an address holds contract code: the "kept address survived a TRE
 * restart" check.
 *
 * @param rpcUrl - The HTTP API base URL.
 * @param address - The 21-byte address to probe.
 * @returns `true` when code is present.
 */
export async function hasTronContractCode(rpcUrl: string, address: Uint8Array): Promise<boolean> {
  const contract = await tronPost<{ bytecode?: string }>(rpcUrl, "/wallet/getcontract", {
    value: bytesToHex(address),
    visible: false,
  });
  return (contract.bytecode ?? "").length > 0;
}
