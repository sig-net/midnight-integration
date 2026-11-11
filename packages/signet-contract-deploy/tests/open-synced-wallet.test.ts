// A cache whose envelope passes every check but whose snapshots the wallet
// SDK cannot restore is refused before any facade is built.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { openSyncedWallet } from "../src/plumbing/wallet.ts";
import {
  sealWalletCache,
  WalletCacheInvalidError,
  WalletCacheRejection,
  writeWalletCacheAtomically,
} from "../src/plumbing/wallet-cache.ts";
import {
  buildWalletCacheFixture,
  FIXTURE_CONFIG,
  type WalletCacheFixture,
} from "./wallet-cache-fixture.ts";

let fixture: WalletCacheFixture;

beforeAll(async () => {
  fixture = await buildWalletCacheFixture();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * One snapshot's own JSON document with its `state` replaced.
 *
 * @param snapshot - The snapshot.
 * @param state - The replacement state.
 * @returns The edited snapshot.
 */
function withState(snapshot: string, state: string): string {
  return JSON.stringify({ ...(JSON.parse(snapshot) as object), state });
}

describe("openSyncedWallet with an unrestorable explicit cache", () => {
  it.each([
    { part: "shielded", edit: { shielded: "shielded" } },
    { part: "dust", edit: { dust: "dust" } },
    { part: "transaction lifecycle", edit: { transactionLifecycle: "not json" } },
  ])("refuses an unrestorable $part snapshot", async ({ part, edit }) => {
    vi.stubGlobal("fetch", (_url: string, init: { body: string }) => {
      const height = (JSON.parse(init.body) as { variables: { offset?: { height: number } } })
        .variables.offset?.height;
      const block =
        height === undefined
          ? { height: 150, hash: "tip", transactions: [] }
          : { height, hash: height === 0 ? "aa" : "bb", transactions: [] };
      return Promise.resolve(new Response(JSON.stringify({ data: { block } })));
    });
    const snapshots = fixture.envelope.snapshots;
    const directory = await mkdtemp(join(tmpdir(), "open-synced-wallet-test-"));
    const path = join(directory, "invoker.json");
    try {
      await writeWalletCacheAtomically(
        path,
        sealWalletCache({
          ...fixture.envelope,
          snapshots: {
            ...snapshots,
            ...("shielded" in edit ? { shielded: withState(snapshots.shielded, "00") } : {}),
            ...("dust" in edit ? { dust: withState(snapshots.dust, "00") } : {}),
            ...("transactionLifecycle" in edit
              ? { transactionLifecycle: edit.transactionLifecycle }
              : {}),
          },
        }),
      );
      const opening = openSyncedWallet({
        keys: fixture.keys,
        config: FIXTURE_CONFIG,
        label: "invoker",
        env: { INVOKER_WALLET_CACHE_PATH: path },
      });
      await expect(opening).rejects.toBeInstanceOf(WalletCacheInvalidError);
      await expect(opening).rejects.toMatchObject({
        refusal: {
          rejection: WalletCacheRejection.SnapshotUnreadable,
          detail: expect.stringContaining(`the ${part} snapshot cannot be restored`) as string,
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
