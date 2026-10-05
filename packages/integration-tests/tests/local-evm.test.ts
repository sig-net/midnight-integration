// The nonce-spend oracle against a scripted JSON-RPC node that, like anvil,
// serves account state only for its most recent blocks. Offline: the node
// is an in-process HTTP server.

import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { findNonceConsumedBlock } from "../src/local-evm.ts";

const ADDRESS = "0x" + "ab".repeat(20);
const NONCE = 5n;

/** What the scripted node serves: the chain tip, the block that spent NONCE, and how far back state is kept. */
interface ScriptedChain {
  readonly tip: number;
  readonly spentAt: number;
  readonly retainedBlocks: number;
}

/** One JSON-RPC request as ethers posts it. */
interface RpcCall {
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

let node: Server | undefined;

afterEach(
  () =>
    new Promise<void>((resolve) => {
      if (node === undefined) {
        resolve();
        return;
      }
      node.close(() => {
        resolve();
      });
      node = undefined;
    }),
);

/**
 * Start the scripted node. `eth_getTransactionCount` answers NONCE + 1 from
 * `spentAt` on and NONCE before it, and refuses blocks older than
 * `retainedBlocks` behind the tip with anvil's BlockOutOfRangeError.
 *
 * @param chain - The chain to script.
 * @param queried - Receives every block number the oracle asked about.
 * @returns The node's URL.
 */
async function serveChain(chain: ScriptedChain, queried: number[]): Promise<string> {
  const answer = (
    call: RpcCall,
  ): { result: string } | { error: { code: number; message: string } } => {
    switch (call.method) {
      case "eth_chainId":
        return { result: "0x7a69" };
      case "eth_blockNumber":
        return { result: "0x" + chain.tip.toString(16) };
      case "eth_getTransactionCount": {
        const block = Number(call.params[1]);
        queried.push(block);
        if (block < chain.tip - chain.retainedBlocks) {
          return {
            error: {
              code: -32602,
              message: `BlockOutOfRangeError: block height is ${String(chain.tip)} but requested was ${String(block)}`,
            },
          };
        }
        return { result: "0x" + (block >= chain.spentAt ? NONCE + 1n : NONCE).toString(16) };
      }
      default:
        return { error: { code: -32601, message: `unscripted method ${call.method}` } };
    }
  };
  const started = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      // ethers batches calls into a JSON array; answer each in kind.
      const posted = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RpcCall | RpcCall[];
      const calls = Array.isArray(posted) ? posted : [posted];
      const answers = calls.map((call) => ({ jsonrpc: "2.0", id: call.id, ...answer(call) }));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(Array.isArray(posted) ? answers : answers[0]));
    });
  });
  node = started;
  await new Promise<void>((resolve) => {
    started.listen(0, "127.0.0.1", resolve);
  });
  const address = started.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${String(address.port)}`;
}

describe("findNonceConsumedBlock", () => {
  const CASES: readonly (ScriptedChain & { name: string })[] = [
    { name: "a spend at the tip", tip: 11339, spentAt: 11339, retainedBlocks: 4000 },
    { name: "a spend one block back", tip: 11339, spentAt: 11338, retainedBlocks: 4000 },
    {
      name: "a spend 250 blocks back on a long-lived chain",
      tip: 11339,
      spentAt: 11089,
      retainedBlocks: 4000,
    },
    {
      name: "a spend half the retained window back",
      tip: 11339,
      spentAt: 9340,
      retainedBlocks: 4000,
    },
    { name: "a fresh chain spent at block 3", tip: 40, spentAt: 3, retainedBlocks: 4000 },
    { name: "a spend in the genesis block", tip: 40, spentAt: 0, retainedBlocks: 4000 },
    { name: "a chain that keeps everything", tip: 11339, spentAt: 12, retainedBlocks: 1_000_000 },
  ];

  it.each(CASES)("finds $name without reading pruned state", async (chain) => {
    const queried: number[] = [];
    const url = await serveChain(chain, queried);
    await expect(findNonceConsumedBlock(url, ADDRESS, NONCE)).resolves.toBe(BigInt(chain.spentAt));
    // The gallop's reach: never more than twice the spend's age behind the tip.
    const age = chain.tip - chain.spentAt;
    expect(Math.min(...queried)).toBeGreaterThanOrEqual(Math.max(0, chain.tip - 2 * age - 1));
    expect(Math.min(...queried)).toBeGreaterThanOrEqual(chain.tip - chain.retainedBlocks);
  });

  it("refuses an unspent nonce", async () => {
    const url = await serveChain({ tip: 100, spentAt: 101, retainedBlocks: 4000 }, []);
    await expect(findNonceConsumedBlock(url, ADDRESS, NONCE)).rejects.toThrow(
      /has not spent nonce 5/,
    );
  });
});
