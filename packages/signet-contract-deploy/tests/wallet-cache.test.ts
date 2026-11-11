// The wallet sync cache's offline behaviour: where the file lives, which
// files are refused and what a refusal does, the chain checks, and writing.
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { deriveAddresses, loadWalletCache, type WalletAddresses } from "../src/plumbing/wallet.ts";
import {
  checkWalletCacheChain,
  checkWalletCacheEnvelope,
  resolveWalletCacheLocation,
  sealWalletCache,
  WALLET_CACHE_WRITE_INTERVAL_MS,
  type WalletCacheChain,
  walletCacheDigest,
  type WalletCacheEnvelope,
  walletCacheEnvVar,
  type WalletCacheFields,
  type WalletCacheIdentity,
  WalletCacheInvalidError,
  type WalletCacheLocation,
  WalletCachePathSource,
  WalletCacheRejection,
  type WalletCacheSnapshots,
  WalletCacheWriter,
  writeWalletCacheAtomically,
} from "../src/plumbing/wallet-cache.ts";
import {
  buildWalletCacheFixture,
  FIXTURE_CHAIN,
  FIXTURE_CONFIG,
  type WalletCacheFixture,
} from "./wallet-cache-fixture.ts";

const ADDRESSES: WalletAddresses = {
  unshielded: "mn_addr_preview1unshielded",
  shielded: "mn_shield-addr_preview1shielded",
  dust: "mn_dust_preview1dust",
};

const SNAPSHOTS: WalletCacheSnapshots = {
  shielded: "shielded state",
  unshielded: "unshielded state",
  dust: "dust state",
  transactionHistory: "history",
  transactionLifecycle: "lifecycle",
};

const VALID_ENVELOPE: WalletCacheEnvelope = sealWalletCache({
  formatVersion: 1,
  networkId: "preview",
  addresses: ADDRESSES,
  chainAnchor: { genesisHash: "aa", seenBlock: { height: 100, hash: "bb" } },
  skipLedgerV8DustHistory: true,
  savedAt: "2026-11-11T12:00:00.000Z",
  snapshots: SNAPSHOTS,
});

/** A JSON value as a cache file holds it. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A cache file's top-level object. */
type JsonObject = Record<string, Json>;

let scratch: string;
let fixture: WalletCacheFixture;
let identity: WalletCacheIdentity;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "wallet-cache-test-"));
  await mkdir(join(scratch, "repo", ".git"), { recursive: true });
  await mkdir(join(scratch, "repo", "packages", "member"), { recursive: true });
  await mkdir(join(scratch, "worktree"), { recursive: true });
  await writeFile(join(scratch, "worktree", ".git"), "gitdir: elsewhere\n");
  await mkdir(join(scratch, "plain"), { recursive: true });
  fixture = await buildWalletCacheFixture();
  identity = {
    networkId: FIXTURE_CONFIG.networkId,
    addresses: deriveAddresses(fixture.keys, FIXTURE_CONFIG.networkId),
    coinPublicKey: fixture.keys.shieldedSecretKeys.coinPublicKey,
    encryptionPublicKey: fixture.keys.shieldedSecretKeys.encryptionPublicKey,
    dustPublicKey: fixture.keys.dustSecretKey.publicKey,
    skipLedgerV8DustHistory: true,
  };
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("walletCacheEnvVar", () => {
  it.each([
    { label: "deployer", envVar: "DEPLOYER_WALLET_CACHE_PATH" },
    { label: "mpc responder", envVar: "MPC_RESPONDER_WALLET_CACHE_PATH" },
    { label: "  Root--wallet!", envVar: "ROOT_WALLET_WALLET_CACHE_PATH" },
  ])("names $label's variable $envVar", ({ label, envVar }) => {
    expect(walletCacheEnvVar(label)).toBe(envVar);
  });

  it("refuses a label with no letter or digit", () => {
    expect(() => walletCacheEnvVar(" - ")).toThrow(/holds no letter or digit/);
  });
});

describe("resolveWalletCacheLocation", () => {
  /** One location case, paths relative to the scratch directory. */
  interface LocationCase {
    readonly name: string;
    readonly env: Record<string, string | undefined>;
    readonly label: string;
    readonly workingDirectory: string;
    readonly path: string;
    readonly source: WalletCachePathSource;
    readonly displayPath: string;
  }

  const CASES: readonly LocationCase[] = [
    {
      name: "the default path in a checkout's root",
      env: {},
      label: "deployer",
      workingDirectory: "repo/packages/member",
      path: "repo/.wallet-cache-preview-deployer-b686cb5aafe0.json",
      source: WalletCachePathSource.Default,
      displayPath: ".wallet-cache-preview-deployer-b686cb5aafe0.json",
    },
    {
      name: "the default path in a worktree, whose .git is a file",
      env: {},
      label: "mpc responder",
      workingDirectory: "worktree",
      path: "worktree/.wallet-cache-preview-mpc-responder-b686cb5aafe0.json",
      source: WalletCachePathSource.Default,
      displayPath: ".wallet-cache-preview-mpc-responder-b686cb5aafe0.json",
    },
    {
      name: "the default path when the variable is blank",
      env: { DEPLOYER_WALLET_CACHE_PATH: "  " },
      label: "deployer",
      workingDirectory: "repo",
      path: "repo/.wallet-cache-preview-deployer-b686cb5aafe0.json",
      source: WalletCachePathSource.Default,
      displayPath: ".wallet-cache-preview-deployer-b686cb5aafe0.json",
    },
    {
      name: "a relative explicit path, against the repository root",
      env: { DEPLOYER_WALLET_CACHE_PATH: "caches/deployer.json" },
      label: "deployer",
      workingDirectory: "repo/packages/member",
      path: "repo/caches/deployer.json",
      source: WalletCachePathSource.Explicit,
      displayPath: "caches/deployer.json",
    },
  ];

  it.each(CASES)("resolves $name", (row) => {
    const location = resolveWalletCacheLocation(
      row.env,
      row.label,
      "preview",
      ADDRESSES,
      join(scratch, row.workingDirectory),
    );
    expect(location).toEqual({
      path: join(scratch, row.path),
      source: row.source,
      envVar: walletCacheEnvVar(row.label),
      displayPath: row.displayPath,
    });
  });

  it("resolves a relative explicit path outside any repository against the working directory", () => {
    const location = resolveWalletCacheLocation(
      { DEPLOYER_WALLET_CACHE_PATH: "deployer.json" },
      "deployer",
      "preview",
      ADDRESSES,
      join(scratch, "plain"),
    );
    expect(location?.path).toBe(join(scratch, "plain", "deployer.json"));
    expect(location?.displayPath).toBe(join(scratch, "plain", "deployer.json"));
  });

  it("resolves an absolute explicit path as given", () => {
    const location = resolveWalletCacheLocation(
      { DEPLOYER_WALLET_CACHE_PATH: "/var/cache/deployer.json" },
      "deployer",
      "preview",
      ADDRESSES,
      join(scratch, "repo"),
    );
    expect(location?.path).toBe("/var/cache/deployer.json");
    expect(location?.source).toBe(WalletCachePathSource.Explicit);
  });

  it("gives two seeds under one label different default files", () => {
    const first = resolveWalletCacheLocation(
      {},
      "user",
      "preview",
      ADDRESSES,
      join(scratch, "repo"),
    );
    const second = resolveWalletCacheLocation(
      {},
      "user",
      "preview",
      { ...ADDRESSES, unshielded: "mn_addr_preview1otherseed" },
      join(scratch, "repo"),
    );
    expect(first?.path).toBe(join(scratch, "repo", ".wallet-cache-preview-user-b686cb5aafe0.json"));
    expect(second?.path).toBe(
      join(scratch, "repo", ".wallet-cache-preview-user-bb191ab50c78.json"),
    );
  });

  it("has no location without a repository root or a named path", () => {
    expect(
      resolveWalletCacheLocation({}, "deployer", "preview", ADDRESSES, join(scratch, "plain")),
    ).toBeUndefined();
  });
});

describe("effect Schema on excess properties", () => {
  it("ignores an unknown field by default, so the envelope decodes with onExcessProperty error", () => {
    const struct = Schema.Struct({ known: Schema.String });
    expect(Schema.decodeUnknownSync(struct)({ known: "x", extra: 1 })).toEqual({ known: "x" });
    expect(() =>
      Schema.decodeUnknownSync(struct)({ known: "x", extra: 1 }, { onExcessProperty: "error" }),
    ).toThrow(/is unexpected/);
  });
});

/**
 * The fixture's envelope, damaged and optionally sealed again.
 *
 * @param damage - Damages the parsed envelope in place.
 * @param reseal - Whether to recompute the digest after the damage.
 * @returns The damaged file's text.
 */
function damagedFixture(damage: (envelope: JsonObject) => void, reseal: boolean): string {
  const envelope = JSON.parse(JSON.stringify(fixture.envelope)) as JsonObject;
  damage(envelope);
  if (reseal) {
    const fields = JSON.parse(JSON.stringify(envelope)) as WalletCacheFields;
    envelope.digest = walletCacheDigest(fields);
  }
  return JSON.stringify(envelope);
}

/**
 * Damage one snapshot's own JSON document in an envelope.
 *
 * @param envelope - The parsed envelope.
 * @param part - The snapshot.
 * @param damage - Damages the parsed snapshot in place.
 */
function damageSnapshot(
  envelope: JsonObject,
  part: keyof WalletCacheSnapshots,
  damage: (snapshot: JsonObject) => void,
): void {
  const snapshots = envelope.snapshots as JsonObject;
  const snapshot = JSON.parse(snapshots[part] as string) as JsonObject;
  damage(snapshot);
  snapshots[part] = JSON.stringify(snapshot);
}

describe("checkWalletCacheEnvelope", () => {
  it("accepts the valid fixture", () => {
    expect(checkWalletCacheEnvelope(JSON.stringify(fixture.envelope), identity)).toEqual({
      envelope: fixture.envelope,
    });
  });

  it("refuses text that is not JSON", () => {
    expect(checkWalletCacheEnvelope("{", identity)).toMatchObject({
      rejection: WalletCacheRejection.Unparseable,
    });
  });

  /** One damage, whether the digest is recomputed after it, and the rejection it earns. */
  interface RefusalCase {
    readonly name: string;
    readonly damage: (envelope: JsonObject) => void;
    readonly reseal: boolean;
    readonly rejection: WalletCacheRejection;
  }

  const CASES: readonly RefusalCase[] = [
    {
      name: "another format version",
      damage: (envelope) => {
        envelope.formatVersion = 2;
      },
      reseal: true,
      rejection: WalletCacheRejection.UnsupportedFormat,
    },
    {
      name: "an unknown top-level field",
      damage: (envelope) => {
        envelope.extra = "x";
      },
      reseal: true,
      rejection: WalletCacheRejection.Unparseable,
    },
    {
      name: "an unknown nested field",
      damage: (envelope) => {
        (envelope.addresses as JsonObject).extra = "x";
      },
      reseal: true,
      rejection: WalletCacheRejection.Unparseable,
    },
    {
      name: "an empty snapshot",
      damage: (envelope) => {
        (envelope.snapshots as JsonObject).transactionLifecycle = "";
      },
      reseal: true,
      rejection: WalletCacheRejection.Unparseable,
    },
    {
      name: "no digest",
      damage: (envelope) => {
        delete envelope.digest;
      },
      reseal: false,
      rejection: WalletCacheRejection.Unparseable,
    },
    {
      name: "a field edited after sealing",
      damage: (envelope) => {
        envelope.savedAt = "2026-11-12T00:00:00.000Z";
      },
      reseal: false,
      rejection: WalletCacheRejection.DigestMismatch,
    },
    {
      name: "another network",
      damage: (envelope) => {
        envelope.networkId = "preprod";
      },
      reseal: true,
      rejection: WalletCacheRejection.NetworkMismatch,
    },
    {
      name: "a shielded snapshot written for another network",
      damage: (envelope) => {
        damageSnapshot(envelope, "shielded", (snapshot) => {
          snapshot.networkId = "preprod";
        });
      },
      reseal: true,
      rejection: WalletCacheRejection.NetworkMismatch,
    },
    {
      name: "the other DUST history setting",
      damage: (envelope) => {
        envelope.skipLedgerV8DustHistory = false;
      },
      reseal: true,
      rejection: WalletCacheRejection.DustHistorySettingMismatch,
    },
    {
      name: "another seed's envelope address",
      damage: (envelope) => {
        (envelope.addresses as JsonObject).shielded = "mn_shield-addr_preview1other";
      },
      reseal: true,
      rejection: WalletCacheRejection.IdentityMismatch,
    },
    {
      name: "another seed's shielded coin key",
      damage: (envelope) => {
        damageSnapshot(envelope, "shielded", (snapshot) => {
          (snapshot.publicKeys as JsonObject).coinPublicKey = "c1".repeat(32);
        });
      },
      reseal: true,
      rejection: WalletCacheRejection.IdentityMismatch,
    },
    {
      name: "another seed's shielded encryption key",
      damage: (envelope) => {
        damageSnapshot(envelope, "shielded", (snapshot) => {
          (snapshot.publicKeys as JsonObject).encryptionPublicKey = "e1".repeat(32);
        });
      },
      reseal: true,
      rejection: WalletCacheRejection.IdentityMismatch,
    },
    {
      name: "another seed's unshielded address",
      damage: (envelope) => {
        damageSnapshot(envelope, "unshielded", (snapshot) => {
          (snapshot.publicKey as JsonObject).address = "mn_addr_preview1other";
        });
      },
      reseal: true,
      rejection: WalletCacheRejection.IdentityMismatch,
    },
    {
      name: "a UTXO owned by another address",
      damage: (envelope) => {
        damageSnapshot(envelope, "unshielded", (snapshot) => {
          const state = snapshot.state as JsonObject;
          const [entry] = state.availableUtxos as JsonObject[];
          if (entry === undefined) throw new Error("the fixture holds one UTXO");
          (entry.utxo as JsonObject).owner = "mn_addr_preview1other";
        });
      },
      reseal: true,
      rejection: WalletCacheRejection.IdentityMismatch,
    },
    {
      name: "another seed's dust key",
      damage: (envelope) => {
        damageSnapshot(envelope, "dust", (snapshot) => {
          (snapshot.publicKey as JsonObject).publicKey = "42";
        });
      },
      reseal: true,
      rejection: WalletCacheRejection.IdentityMismatch,
    },
    {
      name: "a UTXO the history shows unspent, removed",
      damage: (envelope) => {
        damageSnapshot(envelope, "unshielded", (snapshot) => {
          (snapshot.state as JsonObject).availableUtxos = [];
        });
      },
      reseal: true,
      rejection: WalletCacheRejection.InconsistentSnapshots,
    },
    {
      name: "the history entry that created the held UTXO, removed",
      damage: (envelope) => {
        damageSnapshot(envelope, "transactionHistory", (snapshot) => {
          snapshot.entries = [];
        });
      },
      reseal: true,
      rejection: WalletCacheRejection.InconsistentSnapshots,
    },
    {
      name: "an unshielded cursor behind a finalized transaction",
      damage: (envelope) => {
        damageSnapshot(envelope, "unshielded", (snapshot) => {
          snapshot.appliedId = "100";
        });
      },
      reseal: true,
      rejection: WalletCacheRejection.InconsistentSnapshots,
    },
    {
      name: "a dust snapshot without its format version",
      damage: (envelope) => {
        damageSnapshot(envelope, "dust", (snapshot) => {
          delete snapshot.version;
        });
      },
      reseal: true,
      rejection: WalletCacheRejection.Unparseable,
    },
  ];

  it.each(CASES)("refuses $name", ({ damage, reseal, rejection }) => {
    expect(checkWalletCacheEnvelope(damagedFixture(damage, reseal), identity)).toMatchObject({
      rejection,
    });
  });
});

describe("checkWalletCacheChain", () => {
  /** One chain the fixture is checked against, and whether it is refused. */
  interface ChainCase {
    readonly name: string;
    readonly genesis: string;
    readonly block100: string | undefined;
    readonly tipHeight: number;
    readonly lastTransactionId: bigint | undefined;
    readonly lastLedgerEventId: bigint | undefined;
    readonly refused: boolean;
  }

  const ON_CHAIN = {
    genesis: "aa",
    block100: "bb",
    tipHeight: 150,
    lastTransactionId: 800000n,
    lastLedgerEventId: 1900000n,
  };

  const CASES: readonly ChainCase[] = [
    { name: "the chain it was written on", ...ON_CHAIN, refused: false },
    { name: "another genesis", ...ON_CHAIN, genesis: "a0", refused: true },
    { name: "another block at the seen height", ...ON_CHAIN, block100: "b0", refused: true },
    { name: "a chain short of the seen height", ...ON_CHAIN, block100: undefined, refused: true },
    { name: "a tip below the seen block", ...ON_CHAIN, tipHeight: 90, refused: true },
    {
      name: "both ledger cursors past the newest event",
      ...ON_CHAIN,
      lastLedgerEventId: 1000n,
      refused: true,
    },
    {
      name: "the dust cursor alone past the newest event",
      ...ON_CHAIN,
      lastLedgerEventId: 1861500n,
      refused: true,
    },
    {
      name: "a ledger cursor one past the newest event",
      ...ON_CHAIN,
      lastLedgerEventId: 1861884n,
      refused: false,
    },
    {
      name: "the unshielded cursor past the newest transaction",
      ...ON_CHAIN,
      lastTransactionId: 700000n,
      refused: true,
    },
    {
      name: "a tip with no transaction near it",
      ...ON_CHAIN,
      lastTransactionId: undefined,
      lastLedgerEventId: undefined,
      refused: false,
    },
  ];

  it.each(CASES)("judges $name", async (row) => {
    const chain: WalletCacheChain = {
      readBlock: (height) => {
        const hash = height === 0 ? row.genesis : height === 100 ? row.block100 : undefined;
        return Promise.resolve(hash === undefined ? undefined : { height: height ?? 0, hash });
      },
      readTip: () =>
        Promise.resolve({
          block: { height: row.tipHeight, hash: "tip" },
          lastTransactionId: row.lastTransactionId,
          lastLedgerEventId: row.lastLedgerEventId,
        }),
    };
    const refusal = await checkWalletCacheChain(fixture.envelope, chain);
    expect(refusal?.rejection).toBe(row.refused ? WalletCacheRejection.ChainMismatch : undefined);
  });
});

describe("checkWalletCacheChain on a doctored shielded cursor", () => {
  it("refuses a shielded cursor alone past the newest ledger event", async () => {
    const doctored = sealWalletCache({
      ...fixture.envelope,
      snapshots: {
        ...fixture.envelope.snapshots,
        shielded: JSON.stringify({
          ...(JSON.parse(fixture.envelope.snapshots.shielded) as object),
          offset: "1900002",
        }),
      },
    });
    await expect(checkWalletCacheChain(doctored, FIXTURE_CHAIN)).resolves.toMatchObject({
      rejection: WalletCacheRejection.ChainMismatch,
      detail: expect.stringContaining("shielded cursor 1900002") as string,
    });
  });
});

describe("loadWalletCache", () => {
  /**
   * A location in a fresh directory of the scratch area.
   *
   * @param source - Whether the path counts as default or explicit.
   * @returns The location, its file not yet written.
   */
  async function freshLocation(source: WalletCachePathSource): Promise<WalletCacheLocation> {
    const directory = await mkdtemp(join(scratch, "load-"));
    const path = join(directory, "cache.json");
    return { path, source, envVar: "DEPLOYER_WALLET_CACHE_PATH", displayPath: path };
  }

  const UNREACHABLE_CHAIN: WalletCacheChain = {
    readBlock: () => Promise.reject(new Error("indexer cannot be reached")),
    readTip: () => Promise.reject(new Error("indexer cannot be reached")),
  };

  it("has no cache, and logs it, when the file is absent", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const location = await freshLocation(WalletCachePathSource.Default);
    await expect(
      loadWalletCache(location, fixture.keys, FIXTURE_CONFIG, {}, FIXTURE_CHAIN, "deployer"),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      `deployer wallet: no cache at ${location.path}, syncing from scratch`,
    );
  });

  it("restores a valid cache and logs its save time", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const location = await freshLocation(WalletCachePathSource.Explicit);
    await writeWalletCacheAtomically(location.path, fixture.envelope);
    const restored = await loadWalletCache(
      location,
      fixture.keys,
      FIXTURE_CONFIG,
      {},
      FIXTURE_CHAIN,
      "deployer",
    );
    expect(restored?.snapshots).toEqual(fixture.envelope.snapshots);
    expect(log).toHaveBeenCalledWith(
      `deployer wallet: restored from cache ${location.path} (saved 2026-11-11T12:00:00.000Z)`,
    );
  });

  it("drops a damaged cache at the default path and logs why on one line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const location = await freshLocation(WalletCachePathSource.Default);
    await writeFile(location.path, JSON.stringify(fixture.envelope).slice(0, 40));
    await expect(
      loadWalletCache(location, fixture.keys, FIXTURE_CONFIG, {}, FIXTURE_CHAIN, "deployer"),
    ).resolves.toBeUndefined();
    await expect(stat(location.path)).rejects.toThrow(/ENOENT/);
    expect(log).toHaveBeenCalledWith(
      `deployer wallet: dropped cache ${location.path} (unparseable: Expected ',' or '}' after property value in JSON at position 40 (line 1 column 41)), syncing from scratch`,
    );
  });

  it("refuses a damaged cache at an explicit path and keeps the file", async () => {
    const location = await freshLocation(WalletCachePathSource.Explicit);
    await writeFile(location.path, JSON.stringify({ ...fixture.envelope, savedAt: "edited" }));
    const loading = loadWalletCache(
      location,
      fixture.keys,
      FIXTURE_CONFIG,
      {},
      FIXTURE_CHAIN,
      "deployer",
    );
    await expect(loading).rejects.toBeInstanceOf(WalletCacheInvalidError);
    await expect(loading).rejects.toThrow(
      `DEPLOYER_WALLET_CACHE_PATH names ${location.path}, which holds an invalid wallet cache (digest-mismatch)`,
    );
    await expect(stat(location.path)).resolves.toBeDefined();
  });

  it.each([WalletCachePathSource.Default, WalletCachePathSource.Explicit])(
    "keeps a %s-path file when the chain cannot be reached",
    async (source) => {
      const location = await freshLocation(source);
      await writeWalletCacheAtomically(location.path, fixture.envelope);
      await expect(
        loadWalletCache(location, fixture.keys, FIXTURE_CONFIG, {}, UNREACHABLE_CHAIN, "deployer"),
      ).rejects.toThrow("indexer cannot be reached");
      await expect(stat(location.path)).resolves.toBeDefined();
    },
  );
});

describe("writeWalletCacheAtomically", () => {
  it("writes an owner-only file and leaves no temporary file behind", async () => {
    const directory = await mkdtemp(join(scratch, "write-"));
    const path = join(directory, "cache.json");
    await writeWalletCacheAtomically(path, VALID_ENVELOPE);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(VALID_ENVELOPE);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["cache.json"]);
  });

  it("leaves the previous file intact when the write fails", async () => {
    const directory = await mkdtemp(join(scratch, "write-"));
    const path = join(directory, "cache.json");
    await writeWalletCacheAtomically(path, VALID_ENVELOPE);
    await chmod(directory, 0o500);
    try {
      await expect(
        writeWalletCacheAtomically(path, {
          ...VALID_ENVELOPE,
          savedAt: "2026-11-12T00:00:00.000Z",
        }),
      ).rejects.toThrow(/EACCES/);
    } finally {
      await chmod(directory, 0o700);
    }
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(VALID_ENVELOPE);
    expect(await readdir(directory)).toEqual(["cache.json"]);
  });

  it("leaves one whole envelope when two writers race", async () => {
    const directory = await mkdtemp(join(scratch, "write-"));
    const path = join(directory, "cache.json");
    const other = { ...VALID_ENVELOPE, savedAt: "2026-11-12T00:00:00.000Z" };
    await Promise.all([
      writeWalletCacheAtomically(path, VALID_ENVELOPE),
      writeWalletCacheAtomically(path, other),
    ]);
    expect([VALID_ENVELOPE, other]).toContainEqual(JSON.parse(await readFile(path, "utf8")));
    expect(await readdir(directory)).toEqual(["cache.json"]);
  });
});

describe("WalletCacheWriter", () => {
  const HEADER: Omit<WalletCacheFields, "savedAt" | "snapshots"> = {
    formatVersion: 1,
    networkId: "preview",
    addresses: VALID_ENVELOPE.addresses,
    chainAnchor: VALID_ENVELOPE.chainAnchor,
    skipLedgerV8DustHistory: true,
  };
  const ADVANCED: WalletCacheSnapshots = { ...SNAPSHOTS, shielded: `${SNAPSHOTS.shielded} ` };

  /**
   * A location in a fresh directory of the scratch area.
   *
   * @returns The location, its file not yet written.
   */
  async function freshLocation(): Promise<WalletCacheLocation> {
    const directory = await mkdtemp(join(scratch, "writer-"));
    const path = join(directory, "cache.json");
    return {
      path,
      source: WalletCachePathSource.Default,
      envVar: "DEPLOYER_WALLET_CACHE_PATH",
      displayPath: path,
    };
  }

  it("skips state equal to the last written and writes state that changed", async () => {
    const location = await freshLocation();
    let current = SNAPSHOTS;
    const writer = new WalletCacheWriter(
      location,
      HEADER,
      () => Promise.resolve(current),
      "deployer",
      SNAPSHOTS,
    );
    await expect(writer.flush(false)).resolves.toBe(false);
    await expect(stat(location.path)).rejects.toThrow(/ENOENT/);
    current = ADVANCED;
    await expect(writer.flush(false)).resolves.toBe(true);
    const written = JSON.parse(await readFile(location.path, "utf8")) as WalletCacheEnvelope;
    expect(written).toMatchObject({ ...HEADER, snapshots: ADVANCED });
    expect(written.digest).toBe(walletCacheDigest(written));
    await expect(writer.flush(false)).resolves.toBe(false);
  });

  it("writes unchanged state when forced", async () => {
    const location = await freshLocation();
    const writer = new WalletCacheWriter(
      location,
      HEADER,
      () => Promise.resolve(SNAPSHOTS),
      "deployer",
      SNAPSHOTS,
    );
    await expect(writer.flush(true)).resolves.toBe(true);
    expect(JSON.parse(await readFile(location.path, "utf8"))).toMatchObject({
      snapshots: SNAPSHOTS,
    });
  });

  it("warns on a failed capture and writes at the next attempt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const location = await freshLocation();
    const capture = vi
      .fn<() => Promise<WalletCacheSnapshots>>()
      .mockRejectedValueOnce(new Error("serialise failed"))
      .mockResolvedValue(ADVANCED);
    const writer = new WalletCacheWriter(location, HEADER, capture, "deployer", SNAPSHOTS);
    await expect(writer.flush(false)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      `deployer wallet: writing cache ${location.path} failed, the sync carries on:`,
      expect.any(Error),
    );
    await expect(writer.flush(false)).resolves.toBe(true);
  });

  it("captures once per interval after start and stops with a final write", async () => {
    vi.useFakeTimers();
    const location = await freshLocation();
    const capture = vi.fn<() => Promise<WalletCacheSnapshots>>().mockResolvedValue(SNAPSHOTS);
    const writer = new WalletCacheWriter(location, HEADER, capture, "deployer", SNAPSHOTS);
    writer.start();
    await vi.advanceTimersByTimeAsync(WALLET_CACHE_WRITE_INTERVAL_MS - 1);
    expect(capture).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WALLET_CACHE_WRITE_INTERVAL_MS);
    expect(capture).toHaveBeenCalledTimes(2);
    capture.mockResolvedValue(ADVANCED);
    vi.useRealTimers();
    await writer.stop();
    expect(capture).toHaveBeenCalledTimes(3);
    expect(JSON.parse(await readFile(location.path, "utf8"))).toMatchObject({
      snapshots: ADVANCED,
    });
  });
});

describe("the one-line refusal reason", () => {
  it("names the missing field's path", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const directory = await mkdtemp(join(scratch, "reason-"));
    const location: WalletCacheLocation = {
      path: join(directory, "cache.json"),
      source: WalletCachePathSource.Default,
      envVar: "DEPLOYER_WALLET_CACHE_PATH",
      displayPath: "cache.json",
    };
    const { digest: _digest, ...undigested } = fixture.envelope;
    await writeFile(location.path, JSON.stringify(undigested));
    await loadWalletCache(location, fixture.keys, FIXTURE_CONFIG, {}, FIXTURE_CHAIN, "deployer");
    expect(log).toHaveBeenCalledWith(
      'deployer wallet: dropped cache cache.json (unparseable: ["digest"] is missing), syncing from scratch',
    );
  });
});
