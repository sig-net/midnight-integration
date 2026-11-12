// unshieldedSyncPosition: progress record in, heartbeat text out. Pure.

import { IndexerLiveness } from "@midnightntwrk/wallet-sdk-abstractions";
import { describe, expect, it } from "vitest";

import { unshieldedSyncPosition, type UnshieldedSyncProgress } from "../src/plumbing/wallet.ts";

const SYNCED: UnshieldedSyncProgress = {
  appliedId: 40n,
  highestTransactionId: 80n,
  isConnected: true,
  indexerLiveness: IndexerLiveness.InSync({ indexerHeight: 900n, finalizedHeight: 900n }),
};

describe("unshieldedSyncPosition", () => {
  interface Case {
    name: string;
    progress: UnshieldedSyncProgress;
    expected: string;
  }
  const CASES: Case[] = [
    {
      name: "a wallet the indexer has sent nothing to",
      progress: { ...SYNCED, appliedId: 0n, highestTransactionId: 0n, isConnected: false },
      expected: "waiting for the indexer's first progress frame",
    },
    {
      name: "a connected wallet whose address never transacted",
      progress: { ...SYNCED, appliedId: 0n, highestTransactionId: 0n },
      expected: "no transactions for this address",
    },
    {
      name: "a wallet partway through its address's transactions",
      progress: SYNCED,
      expected: "40/80 (50%)",
    },
    {
      name: "a wallet whose node head check has no verdict yet",
      progress: { ...SYNCED, indexerLiveness: IndexerLiveness.Unknown() },
      expected: "40/80 (50%), node head check pending",
    },
    {
      name: "a wallet whose node head check keeps failing",
      progress: {
        ...SYNCED,
        indexerLiveness: IndexerLiveness.Unavailable({
          consecutiveFailures: 3,
          lastError: "disconnected",
        }),
      },
      expected: "40/80 (50%), node head check failed 3 time(s)",
    },
    {
      name: "an indexer behind the node",
      progress: {
        ...SYNCED,
        indexerLiveness: IndexerLiveness.Behind({
          indexerHeight: 880n,
          finalizedHeight: 900n,
          lag: 20n,
        }),
      },
      expected: "40/80 (50%), indexer 20 block(s) behind the node",
    },
    {
      name: "a check skipped for want of a node",
      progress: {
        ...SYNCED,
        indexerLiveness: IndexerLiveness.Skipped({ reason: "no-node-configured" }),
      },
      expected: "40/80 (50%)",
    },
  ];

  it.each(CASES)("reports $name", ({ progress, expected }) => {
    expect(unshieldedSyncPosition(progress)).toBe(expected);
  });
});
