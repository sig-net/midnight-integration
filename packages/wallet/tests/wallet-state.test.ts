// Sync-state persistence tests, all offline: facade construction does no
// network I/O (the endpoints below are unreachable on purpose, so any
// eager connection would fail these tests), which lets the restore
// round-trip and the LocalWallet guards run without a stack.

import { describe, expect, it } from "vitest";

import { initialiseWalletFacade } from "../src/facade.ts";
import { LocalWallet, MidnightNetwork, type MidnightNodeConfig } from "../src/index.ts";
import { deriveAccountKeys, deriveAddresses } from "../src/keys.ts";
import {
  decodeWalletState,
  encodeWalletState,
  type WalletStateSnapshot,
  type WalletStateStore,
} from "../src/walletStateStore.ts";

const SEED = "7f".repeat(32);
const CONFIG: MidnightNodeConfig = {
  indexerUrl: "http://127.0.0.1:1/api/v1/graphql",
  indexerWsUrl: "ws://127.0.0.1:1/api/v1/graphql",
  nodeUrl: "http://127.0.0.1:1",
  proofServerUrl: "http://127.0.0.1:1",
  networkId: MidnightNetwork.Undeployed,
};

// A store that records every call and serves a canned load result.
class RecordingStore implements WalletStateStore {
  loads: string[] = [];
  saves: { unshieldedAddress: string; state: string }[] = [];
  constructor(private readonly stored?: string) {}
  load(unshieldedAddress: string): Promise<string | undefined> {
    this.loads.push(unshieldedAddress);
    return Promise.resolve(this.stored);
  }
  save(unshieldedAddress: string, state: string): Promise<void> {
    this.saves.push({ unshieldedAddress, state });
    return Promise.resolve();
  }
}

describe("facade snapshot restore", () => {
  it("round-trips all three sub-wallet states through restore", async () => {
    const keys = deriveAccountKeys(SEED, CONFIG.networkId);
    const fresh = await initialiseWalletFacade(keys, CONFIG);
    const snapshot: WalletStateSnapshot = {
      shielded: await fresh.shielded.serializeState(),
      unshielded: await fresh.unshielded.serializeState(),
      dust: await fresh.dust.serializeState(),
    };

    const restored = await initialiseWalletFacade(keys, CONFIG, {}, snapshot);
    expect(await restored.shielded.serializeState()).toBe(snapshot.shielded);
    expect(await restored.unshielded.serializeState()).toBe(snapshot.unshielded);
    expect(await restored.dust.serializeState()).toBe(snapshot.dust);
  });
});

const IDENTITY = {
  networkId: MidnightNetwork.Undeployed,
  unshieldedAddress: "mn_addr_undeployed1walletstate",
};
const SNAPSHOT: WalletStateSnapshot = {
  shielded: "shielded-serialized",
  unshielded: "unshielded-serialized",
  dust: "dust-serialized",
};

// Re-encode the valid envelope with one field replaced, bypassing the
// encoder's own typing so tampered values of any shape can be planted.
function tampered(field: string, value: string | number): string {
  const envelope = JSON.parse(encodeWalletState(SNAPSHOT, IDENTITY)) as Record<string, unknown>;
  return JSON.stringify({ ...envelope, [field]: value });
}

describe("wallet state envelope", () => {
  it("round-trips through encode and decode", () => {
    expect(decodeWalletState(encodeWalletState(SNAPSHOT, IDENTITY), IDENTITY)).toEqual(SNAPSHOT);
  });

  const REJECTED: { name: string; state: string; error: string }[] = [
    { name: "corrupt JSON", state: "definitely-not-json", error: "not valid JSON" },
    { name: "unknown version", state: tampered("version", 99), error: "version 99" },
    {
      name: "different network",
      state: tampered("networkId", "mainnet"),
      error: 'belongs to network "mainnet"',
    },
    {
      name: "different seed (address mismatch)",
      state: tampered("unshieldedAddress", "mn_addr_undeployed1otherwallet"),
      error: "a different seed",
    },
    {
      name: "missing sub-wallet state",
      state: tampered("dust", 5),
      error: "(dust): expected a string",
    },
  ];

  it.each(REJECTED)("rejects $name", ({ state, error }) => {
    expect(() => decodeWalletState(state, IDENTITY)).toThrow(error);
  });
});

describe("LocalWallet state persistence guards", () => {
  it("saveState rejects without a configured store", async () => {
    const wallet = new LocalWallet(SEED, CONFIG);
    await expect(wallet.saveState()).rejects.toThrow("no state store");
  });

  it("saveState rejects on an unconnected wallet", async () => {
    const wallet = new LocalWallet(SEED, CONFIG, { stateStore: new RecordingStore() });
    await expect(wallet.saveState()).rejects.toThrow("not connected");
  });

  it("disconnect on a never-connected wallet saves nothing", async () => {
    const store = new RecordingStore();
    const wallet = new LocalWallet(SEED, CONFIG, { stateStore: store });
    await wallet.disconnect();
    expect(store.saves).toEqual([]);
  });

  it("connect loads by the wallet's own address and refuses a mismatched envelope", async () => {
    const store = new RecordingStore(encodeWalletState(SNAPSHOT, IDENTITY));
    const wallet = new LocalWallet(SEED, CONFIG, { stateStore: store });
    // The stored envelope carries a fabricated address, so it cannot match
    // the address this seed derives: connect must refuse to restore it
    // (before any network I/O, which is what keeps this test offline).
    await expect(wallet.connect()).rejects.toThrow("a different seed");
    const derived = deriveAddresses(deriveAccountKeys(SEED, CONFIG.networkId), CONFIG.networkId);
    expect(store.loads).toEqual([derived.unshielded]);
  });
});
