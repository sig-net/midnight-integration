// Test harness: a real-shaped valid wallet cache, built offline from the
// wallet SDK's own snapshots of a fixed test seed, and a fake chain it is
// anchored to.
import * as ledger from "@midnightntwrk/ledger-v9";
import { InMemoryTransactionHistoryStorage } from "@midnightntwrk/wallet-sdk-abstractions";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import {
  mergeWalletEntries,
  WalletEntrySchema,
  WalletFacade,
} from "@midnightntwrk/wallet-sdk-facade";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import {
  PublicKey as UnshieldedPublicKey,
  UnshieldedWallet,
} from "@midnightntwrk/wallet-sdk-unshielded-wallet";

import type { MidnightNodeConfig } from "../src/plumbing/midnight-node-config.ts";
import { type AccountKeys, deriveAccountKeys, deriveAddresses } from "../src/plumbing/wallet.ts";
import {
  sealWalletCache,
  type WalletCacheChain,
  type WalletCacheEnvelope,
  type WalletCacheSnapshots,
} from "../src/plumbing/wallet-cache.ts";

/** The fixture wallet's seed, a public test value. */
export const FIXTURE_SEED = "01".repeat(32);

/** A node config on `preview` whose endpoints refuse every connection. */
export const FIXTURE_CONFIG: MidnightNodeConfig = {
  networkId: "preview",
  indexerUrl: "http://127.0.0.1:9/api/v4/graphql",
  indexerWsUrl: "ws://127.0.0.1:9/api/v4/graphql/ws",
  nodeUrl: "http://127.0.0.1:9",
  proofServerUrl: "http://127.0.0.1:9",
};

/** A chain with genesis `aa`, block 100 `bb`, its tip at 150, transaction 800000 and ledger event 1900000. */
export const FIXTURE_CHAIN: WalletCacheChain = {
  readBlock: (height) => {
    if (height === undefined) return Promise.resolve({ height: 150, hash: "tip" });
    const hash = new Map([
      [0, "aa"],
      [100, "bb"],
    ]).get(height);
    return Promise.resolve(hash === undefined ? undefined : { height, hash });
  },
  readTip: () =>
    Promise.resolve({
      block: { height: 150, hash: "tip" },
      lastTransactionId: 800000n,
      lastLedgerEventId: 1900000n,
    }),
};

/** A valid cache for {@link FIXTURE_SEED}, and the same wallet's snapshots from an earlier save. */
export interface WalletCacheFixture {
  /** The fixture wallet's keys. */
  readonly keys: AccountKeys;
  /** The valid, sealed cache. */
  readonly envelope: WalletCacheEnvelope;
  /** The snapshots of an earlier save of the same wallet. */
  readonly earlier: WalletCacheSnapshots;
}

/**
 * Build the fixture: the SDK's snapshots of a fresh wallet started at the
 * ledger-v9 variant, with realistic cursors, one NIGHT UTXO and one history
 * entry written in, the shapes a synced preprod wallet's snapshots have.
 *
 * @returns The fixture.
 */
export async function buildWalletCacheFixture(): Promise<WalletCacheFixture> {
  const keys = deriveAccountKeys(FIXTURE_SEED, FIXTURE_CONFIG.networkId);
  const addresses = deriveAddresses(keys, FIXTURE_CONFIG.networkId);
  const resolved = WalletFacade.resolveConfiguration({
    networkId: FIXTURE_CONFIG.networkId,
    indexerClientConnection: {
      indexerHttpUrl: FIXTURE_CONFIG.indexerUrl,
      indexerWsUrl: FIXTURE_CONFIG.indexerWsUrl,
    },
    provingServerUrl: new URL(FIXTURE_CONFIG.proofServerUrl),
    relayURL: new URL("ws://127.0.0.1:9"),
    costParameters: { additionalFeeOverhead: 0n, feeBlocksMargin: 5 },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
  });
  const cfg = { ...resolved, chainVersionProbe: () => Promise.resolve(resolved.forks.v9) };
  const shielded = await ShieldedWallet(cfg).startWithSeed(keys.seeds.shielded);
  const unshielded = await UnshieldedWallet(cfg).startWithPublicKey(
    UnshieldedPublicKey.fromKeyStore(keys.unshieldedKeystore),
  );
  const dust = await DustWallet({ ...cfg, skipLedgerV8DustHistory: false }).startWithSeed(
    keys.seeds.dust,
    ledger.LedgerParameters.initialParameters().dust,
  );
  const fresh = {
    shielded: await shielded.serializeState(),
    unshielded: await unshielded.serializeState(),
    dust: await dust.serializeState(),
  };
  await Promise.all([shielded.stop(), unshielded.stop(), dust.stop()]);

  const utxo = {
    utxo: {
      value: "5000000000",
      owner: addresses.unshielded,
      type: "00".repeat(32),
      intentHash: "5b".repeat(32),
      outputNo: 0,
    },
    meta: { ctime: "2026-11-11T08:40:48.000Z", registeredForDustGeneration: true },
  };
  const historyEntry = {
    hash: "2d".repeat(32),
    identifiers: [`00${"32".repeat(32)}`],
    protocolVersion: 2001100,
    status: "SUCCESS",
    timestamp: "2026-11-10T13:29:24.000Z",
    lifecycle: {
      status: "finalized",
      finalizedBlock: { hash: "4a".repeat(32), height: 90, timestamp: "2026-11-10T13:29:24.000Z" },
    },
    unshielded: {
      id: 735229,
      createdUtxos: [
        {
          value: "5000000000",
          owner: addresses.unshielded,
          tokenType: "00".repeat(32),
          intentHash: "5b".repeat(32),
          outputIndex: 0,
        },
      ],
      spentUtxos: [],
    },
  };
  const withCursor = (snapshot: string, field: string, value: string): string =>
    JSON.stringify({ ...(JSON.parse(snapshot) as object), [field]: value });
  const unshieldedWith = (cursor: string, utxos: readonly object[]): string => {
    const parsed = JSON.parse(fresh.unshielded) as { state: object };
    return JSON.stringify({
      ...parsed,
      appliedId: cursor,
      state: { ...parsed.state, availableUtxos: utxos },
    });
  };
  const envelope = sealWalletCache({
    formatVersion: 1,
    networkId: FIXTURE_CONFIG.networkId,
    addresses,
    chainAnchor: { genesisHash: "aa", seenBlock: { height: 100, hash: "bb" } },
    skipLedgerV8DustHistory: true,
    savedAt: "2026-11-11T12:00:00.000Z",
    snapshots: {
      shielded: withCursor(fresh.shielded, "offset", "1861238"),
      unshielded: unshieldedWith("736462", [utxo]),
      dust: withCursor(fresh.dust, "offset", "1861885"),
      transactionHistory: JSON.stringify({ version: "v2", entries: [historyEntry] }),
      transactionLifecycle: JSON.stringify({ version: "v2", records: [] }),
    },
  });
  const earlier: WalletCacheSnapshots = {
    shielded: withCursor(fresh.shielded, "offset", "1800000"),
    unshielded: unshieldedWith("700000", []),
    dust: withCursor(fresh.dust, "offset", "1800000"),
    transactionHistory: JSON.stringify({ version: "v2", entries: [] }),
    transactionLifecycle: JSON.stringify({ version: "v2", records: [] }),
  };
  return { keys, envelope, earlier };
}
