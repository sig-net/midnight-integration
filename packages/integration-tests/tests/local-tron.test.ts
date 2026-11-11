// The Tron e2e's TaPoS window and expiry-boundary oracle, offline: the
// solidity node is an in-process HTTP server scripting
// /walletsolidity/getblockbynum.

import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  findSolidifiedExpiryBoundary,
  type TronBlockRef,
  tronTxWindowFromBlock,
} from "../src/local-tron.ts";

/** A 32-byte block id whose byte i is i, so any slice is recognisable. */
const BLOCK_ID = Uint8Array.from({ length: 32 }, (_, index) => index);

describe("tronTxWindowFromBlock", () => {
  const CASES: readonly { name: string; reference: TronBlockRef; refBlockBytes: number[] }[] = [
    {
      name: "a height past two bytes keeps its low two bytes",
      reference: { number: 0x1234_5678n, id: BLOCK_ID, timestamp: 1_700_000_001_000n },
      refBlockBytes: [0x56, 0x78],
    },
    {
      name: "a height below 256 is zero-padded big-endian",
      reference: { number: 0x2an, id: BLOCK_ID, timestamp: 1_700_000_001_000n },
      refBlockBytes: [0x00, 0x2a],
    },
    {
      name: "the genesis block",
      reference: { number: 0n, id: BLOCK_ID, timestamp: 0n },
      refBlockBytes: [0x00, 0x00],
    },
  ];

  it.each(CASES)("$name", ({ reference, refBlockBytes }) => {
    expect(tronTxWindowFromBlock(reference, 3_000n, 50_000_000n)).toEqual({
      refBlockBytes: Uint8Array.from(refBlockBytes),
      refBlockHash: Uint8Array.from([8, 9, 10, 11, 12, 13, 14, 15]),
      timestamp: reference.timestamp,
      expiration: reference.timestamp + 3_000n,
      feeLimit: 50_000_000n,
    });
  });
});

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
 * Start a solidity node serving solidified blocks `0..timestamps.length-1`
 * with the given timestamps, and `{}` for any later height.
 *
 * @param timestamps - Each solidified block's timestamp, by height.
 * @returns The node's URL.
 */
async function serveSolidifiedBlocks(timestamps: readonly number[]): Promise<string> {
  const started = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const { num } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { num: number };
      const timestamp = timestamps[num];
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url !== "/walletsolidity/getblockbynum" || timestamp === undefined
            ? {}
            : {
                blockID: num.toString(16).padStart(64, "0"),
                block_header: { raw_data: { number: num, timestamp } },
              },
        ),
      );
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

describe("findSolidifiedExpiryBoundary", () => {
  // Block 0 is the reference at t = 1000; TRE then idles, so the next block
  // lands far past a one-slot window.
  const IDLE_CHAIN = [1000, 600_000, 603_000, 606_000];
  // A busy chain: one block per 3-second slot.
  const BUSY_CHAIN = [1000, 4000, 7000, 10_000];

  const CASES = [
    {
      name: "an idle chain's first block after the reference",
      chain: IDLE_CHAIN,
      expiration: 4000n,
      boundary: 1n,
    },
    {
      name: "a block exactly at the expiration",
      chain: BUSY_CHAIN,
      expiration: 7000n,
      boundary: 2n,
    },
    {
      name: "the first block past an expiration between slots",
      chain: BUSY_CHAIN,
      expiration: 8000n,
      boundary: 3n,
    },
  ];

  it.each(CASES)("finds $name", async ({ chain, expiration, boundary }) => {
    const url = await serveSolidifiedBlocks(chain);
    await expect(findSolidifiedExpiryBoundary(url, 0n, expiration)).resolves.toBe(boundary);
  });

  it("refuses while no solidified block reaches the expiration", async () => {
    const url = await serveSolidifiedBlocks(BUSY_CHAIN);
    await expect(findSolidifiedExpiryBoundary(url, 0n, 20_000n)).rejects.toThrow(
      /solidified block 4 is absent/,
    );
  });
});
