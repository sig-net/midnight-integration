// The java-tron HTTP helpers against an in-process server replaying the Nile answers the MPC's
// own Tron client tests record (fixtures/tron-node-nile-mpc-3d586f3.json). No network beyond
// loopback.

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  broadcastTronTransaction,
  bytesToHex,
  getSolidifiedTronReferenceBlock,
  getSolidifiedTronTransactionInfo,
  hexToBytes,
  type JsonValue,
  TronBroadcastOutcome,
  TronExecutionResult,
  tronReceiptExecutionResult,
  tronTaposReference,
  type TronTransactionReceipt,
} from "../src/index.ts";

interface NileFixture {
  readonly source: string;
  readonly "nowblock-solidity": string;
  readonly "broadcast-accept": string;
  readonly "broadcast-dup": string;
  readonly "broadcast-expired": string;
  readonly "receipt-pending": string;
  readonly "receipt-success": string;
}

const NILE = JSON.parse(
  readFileSync(new URL("fixtures/tron-node-nile-mpc-3d586f3.json", import.meta.url), "utf8"),
) as NileFixture;

interface Served {
  readonly path: string;
  readonly body: string;
}

let server: Server | undefined;

afterEach(async () => {
  const running = server;
  server = undefined;
  if (running !== undefined) {
    await new Promise<void>((resolve) => {
      running.close(() => {
        resolve();
      });
    });
  }
});

async function serveTronNode(status: number, answer: string, served: Served[]): Promise<string> {
  const started = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      served.push({ path: request.url ?? "", body });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(answer);
    });
  });
  server = started;
  await new Promise<void>((resolve) => started.listen(0, "127.0.0.1", resolve));
  const address = started.address();
  if (address === null || typeof address === "string") {
    throw new Error("the Tron node stand-in has no TCP address");
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

const TX_ID = hexToBytes("24157817b0db1a156e7244d4417cbd7303f32b06449fcbad739f124b6b8e4c82");
const SIGNED = Uint8Array.from([0x0a, 0x02, 0x01, 0x02]);

describe("tronTaposReference", () => {
  it.each([
    {
      name: "the recorded Nile solidified head 72266582",
      number: 72_266_582n,
      blockId: "00000000044eb356e06bc438d601e2634fa75ea79d7555b2e20ba1738184edf4",
      refBlockBytes: "b356",
      refBlockHash: "e06bc438d601e263",
    },
    {
      name: "a number past 16 bits keeps only its low two bytes",
      number: 0x01_0002n,
      blockId: "11".repeat(8) + "22".repeat(8) + "33".repeat(16),
      refBlockBytes: "0002",
      refBlockHash: "2222222222222222",
    },
  ])("references $name", ({ number, blockId, refBlockBytes, refBlockHash }) => {
    const reference = tronTaposReference(number, hexToBytes(blockId));
    expect(bytesToHex(reference.refBlockBytes)).toBe(refBlockBytes);
    expect(bytesToHex(reference.refBlockHash)).toBe(refBlockHash);
  });

  it.each([
    { name: "a 31-byte block id", number: 1n, blockId: new Uint8Array(31), error: /32 bytes/ },
    { name: "a negative number", number: -1n, blockId: new Uint8Array(32), error: /64 bits/ },
    { name: "a 2^64 number", number: 2n ** 64n, blockId: new Uint8Array(32), error: /64 bits/ },
  ])("refuses $name", ({ number, blockId, error }) => {
    expect(() => tronTaposReference(number, blockId)).toThrow(error);
  });
});

describe("getSolidifiedTronReferenceBlock", () => {
  it("reads the solidified head and its reference from /walletsolidity/getnowblock", async () => {
    const served: Served[] = [];
    const url = await serveTronNode(200, NILE["nowblock-solidity"], served);
    const block = await getSolidifiedTronReferenceBlock(url);
    expect(served).toEqual([{ path: "/walletsolidity/getnowblock", body: "{}" }]);
    expect(block.number).toBe(72_266_582n);
    expect(block.timestamp).toBe(1_793_335_731_000n);
    expect(bytesToHex(block.refBlockBytes)).toBe("b356");
    expect(bytesToHex(block.refBlockHash)).toBe("e06bc438d601e263");
  });

  it("refuses an answer without a block", async () => {
    const url = await serveTronNode(200, "{}", []);
    await expect(getSolidifiedTronReferenceBlock(url)).rejects.toThrow(/no block id/);
  });
});

describe("broadcastTronTransaction", () => {
  it.each([
    {
      name: "an accepted",
      answer: NILE["broadcast-accept"],
      outcome: TronBroadcastOutcome.Accepted,
    },
    {
      name: "a duplicate",
      answer: NILE["broadcast-dup"],
      outcome: TronBroadcastOutcome.AlreadyKnown,
    },
  ])("takes $name broadcast", async ({ answer, outcome }) => {
    const served: Served[] = [];
    const url = await serveTronNode(200, answer, served);
    await expect(broadcastTronTransaction(url, SIGNED)).resolves.toBe(outcome);
    expect(served).toEqual([{ path: "/wallet/broadcasthex", body: '{"transaction":"0a020102"}' }]);
  });

  it.each([
    {
      name: "an expired transaction with its code and message",
      answer: NILE["broadcast-expired"],
      error: "TRANSACTION_EXPIRATION_ERROR: Transaction expired",
    },
    {
      name: "a hex-encoded message decoded",
      answer: JSON.stringify({
        result: false,
        code: "SIGERROR",
        message: "626164207369676e6174757265",
      }),
      error: "SIGERROR: bad signature",
    },
    { name: "an HTTP error", status: 503, answer: "busy", error: "answered HTTP 503: busy" },
  ])("throws on $name", async ({ answer, status, error }) => {
    const url = await serveTronNode(status ?? 200, answer, []);
    await expect(broadcastTronTransaction(url, SIGNED)).rejects.toThrow(error);
  });
});

describe("getSolidifiedTronTransactionInfo", () => {
  it("reads a final receipt from /walletsolidity/gettransactioninfobyid", async () => {
    const served: Served[] = [];
    const url = await serveTronNode(200, NILE["receipt-success"], served);
    const receipt = await getSolidifiedTronTransactionInfo(url, TX_ID);
    expect(served).toEqual([
      { path: "/walletsolidity/gettransactioninfobyid", body: `{"value":"${bytesToHex(TX_ID)}"}` },
    ]);
    expect(receipt).toEqual({
      id: TX_ID,
      blockNumber: 71_896_097n,
      blockTimestamp: 1_792_220_502_000n,
      fee: 472_800n,
      result: undefined,
      receiptResult: "SUCCESS",
      contractResult: [new Uint8Array(32)],
      body: JSON.parse(NILE["receipt-success"]) as JsonValue,
    });
  });

  it("answers undefined while the transaction is not solidified", async () => {
    const url = await serveTronNode(200, NILE["receipt-pending"], []);
    await expect(getSolidifiedTronTransactionInfo(url, TX_ID)).resolves.toBeUndefined();
  });

  it("refuses a receipt without a block", async () => {
    const url = await serveTronNode(200, JSON.stringify({ id: bytesToHex(TX_ID) }), []);
    await expect(getSolidifiedTronTransactionInfo(url, TX_ID)).rejects.toThrow(/names no block/);
  });
});

const RECEIPT: Pick<TronTransactionReceipt, "result" | "receiptResult"> = {
  result: undefined,
  receiptResult: "SUCCESS",
};

describe("tronReceiptExecutionResult (the MPC's classification, chain-tron/src/types.rs)", () => {
  it.each([
    { name: "receipt SUCCESS", delta: {}, expected: TronExecutionResult.Succeeded },
    { name: "code SUCESS", delta: { result: "SUCESS" }, expected: TronExecutionResult.Succeeded },
    {
      name: "code FAILED over receipt SUCCESS",
      delta: { result: "FAILED" },
      expected: TronExecutionResult.Failed,
    },
    {
      name: "receipt REVERT",
      delta: { receiptResult: "REVERT" },
      expected: TronExecutionResult.Failed,
    },
    {
      name: "receipt OUT_OF_ENERGY",
      delta: { receiptResult: "OUT_OF_ENERGY" },
      expected: TronExecutionResult.Failed,
    },
    {
      name: "receipt TRANSFER_FAILED",
      delta: { receiptResult: "TRANSFER_FAILED" },
      expected: TronExecutionResult.Failed,
    },
  ] as const)("classifies $name", ({ delta, expected }) => {
    expect(tronReceiptExecutionResult({ ...RECEIPT, ...delta })).toBe(expected);
  });

  it.each([
    { name: "no result", delta: { receiptResult: undefined }, error: /no execution result/ },
    { name: "DEFAULT", delta: { receiptResult: "DEFAULT" }, error: /unclassifiable/ },
    { name: "an unknown string", delta: { receiptResult: "WHATEVER" }, error: /unclassifiable/ },
  ] as const)("refuses $name", ({ delta, error }) => {
    expect(() => tronReceiptExecutionResult({ ...RECEIPT, ...delta })).toThrow(error);
  });
});
