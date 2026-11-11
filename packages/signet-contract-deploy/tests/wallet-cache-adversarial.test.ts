// Every damage a cache file can take, measured against the full validation:
// as written (so the digest mismatches) and with the digest recomputed
// to match (only the semantic checks and the SDK's restore stand).
import { beforeAll, describe, expect, it } from "vitest";

import { validateWalletCache } from "../src/plumbing/wallet.ts";
import { walletCacheDigest, WalletCacheRejection } from "../src/plumbing/wallet-cache.ts";
import {
  buildWalletCacheFixture,
  FIXTURE_CHAIN,
  FIXTURE_CONFIG,
  type WalletCacheFixture,
} from "./wallet-cache-fixture.ts";

/** A JSON value as a cache file holds it. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A cache file's top-level object. */
type JsonObject = Record<string, Json>;

/** The envelope's snapshot fields, each a JSON document of its own. */
type SnapshotPart =
  "shielded" | "unshielded" | "dust" | "transactionHistory" | "transactionLifecycle";

const ENVELOPE_FIELDS = [
  "formatVersion",
  "networkId",
  "addresses",
  "chainAnchor",
  "skipLedgerV8DustHistory",
  "savedAt",
  "snapshots",
  "digest",
] as const;

const SNAPSHOT_FIELDS: Readonly<Record<SnapshotPart, readonly string[]>> = {
  shielded: [
    "version",
    "writtenBy",
    "publicKeys",
    "state",
    "protocolVersion",
    "offset",
    "networkId",
    "coinHashes",
  ],
  unshielded: [
    "version",
    "writtenBy",
    "publicKey",
    "state",
    "protocolVersion",
    "appliedId",
    "networkId",
  ],
  dust: [
    "version",
    "writtenBy",
    "publicKey",
    "state",
    "protocolVersion",
    "networkId",
    "offset",
    "syncKind",
    "pendingDust",
  ],
  transactionHistory: ["version", "entries"],
  transactionLifecycle: ["version", "records"],
};

/**
 * The damage rows the semantic checks and the SDK's restore do NOT catch once
 * the digest is recomputed to match: the residual exposure the digest alone
 * covers.
 */
const DIGEST_ONLY: ReadonlySet<string> = new Set([
  "shielded swapped for an earlier save's",
  "dust swapped for an earlier save's",
]);

/** Rows that change nothing in this fixture, whose lists are already empty. */
const NOT_APPLICABLE: ReadonlySet<string> = new Set([
  "shielded.coinHashes emptied",
  "dust.pendingDust emptied",
  "transactionLifecycle.records emptied",
  "transactionLifecycle swapped for an earlier save's",
]);

/** Rows that damage the digest itself, which recomputing the digest repairs. */
const DIGEST_ROWS: ReadonlySet<string> = new Set([
  "envelope digest deleted",
  "envelope digest emptied",
]);

/** One way to damage a cache file. */
interface DamageRow {
  readonly name: string;
  /** Damages a deep copy of the valid envelope in place. */
  readonly damage: (envelope: JsonObject, fixture: WalletCacheFixture) => void;
}

/**
 * The value that empties `value` in its own kind.
 *
 * @param value - The value to empty.
 * @returns An empty string, array or object, zero, or null for a boolean.
 */
function emptyOf(value: Json): Json {
  if (typeof value === "string") return "";
  if (typeof value === "number") return 0;
  if (Array.isArray(value)) return [];
  if (value !== null && typeof value === "object") return {};
  return null;
}

/**
 * Damage one snapshot's own JSON document.
 *
 * @param envelope - The envelope holding it.
 * @param part - The snapshot.
 * @param damage - Damages the parsed snapshot in place.
 */
function damageSnapshot(
  envelope: JsonObject,
  part: SnapshotPart,
  damage: (snapshot: JsonObject) => void,
): void {
  const snapshots = envelope.snapshots as JsonObject;
  const snapshot = JSON.parse(snapshots[part] as string) as JsonObject;
  damage(snapshot);
  snapshots[part] = JSON.stringify(snapshot);
}

const ALL_ROWS: readonly DamageRow[] = [
  ...ENVELOPE_FIELDS.flatMap((field): DamageRow[] => [
    {
      name: `envelope ${field} deleted`,
      damage: (envelope) => {
        Reflect.deleteProperty(envelope, field);
      },
    },
    {
      name: `envelope ${field} emptied`,
      damage: (envelope) => {
        envelope[field] = emptyOf(envelope[field] ?? null);
      },
    },
  ]),
  ...(Object.keys(SNAPSHOT_FIELDS) as SnapshotPart[]).flatMap((part): DamageRow[] => [
    {
      name: `snapshots.${part} deleted`,
      damage: (envelope) => {
        Reflect.deleteProperty(envelope.snapshots as JsonObject, part);
      },
    },
    {
      name: `snapshots.${part} emptied`,
      damage: (envelope) => {
        (envelope.snapshots as JsonObject)[part] = "";
      },
    },
    ...SNAPSHOT_FIELDS[part].flatMap((field): DamageRow[] => [
      {
        name: `${part}.${field} deleted`,
        damage: (envelope) => {
          damageSnapshot(envelope, part, (snapshot) => {
            Reflect.deleteProperty(snapshot, field);
          });
        },
      },
      {
        name: `${part}.${field} emptied`,
        damage: (envelope) => {
          damageSnapshot(envelope, part, (snapshot) => {
            snapshot[field] = emptyOf(snapshot[field] ?? null);
          });
        },
      },
    ]),
    {
      name: `${part} swapped for an earlier save's`,
      damage: (envelope, fixture) => {
        (envelope.snapshots as JsonObject)[part] = fixture.earlier[part];
      },
    },
  ]),
  {
    name: "unshielded.state.availableUtxos lost its one UTXO",
    damage: (envelope) => {
      damageSnapshot(envelope, "unshielded", (snapshot) => {
        (snapshot.state as JsonObject).availableUtxos = [];
      });
    },
  },
  {
    name: "transactionHistory.entries lost its one entry",
    damage: (envelope) => {
      damageSnapshot(envelope, "transactionHistory", (snapshot) => {
        snapshot.entries = [];
      });
    },
  },
];

const ROWS = ALL_ROWS.filter((row) => !NOT_APPLICABLE.has(row.name));

const RESEALED_ROWS = ROWS.filter((row) => !DIGEST_ROWS.has(row.name));

const TRUNCATIONS: readonly number[] = [1, 100, 0.5, -1];

let fixture: WalletCacheFixture;

beforeAll(async () => {
  fixture = await buildWalletCacheFixture();
});

/**
 * Apply a damage row to a deep copy of the fixture's envelope.
 *
 * @param row - The damage.
 * @returns The damaged envelope's JSON object.
 */
function damaged(row: DamageRow): JsonObject {
  const envelope = JSON.parse(JSON.stringify(fixture.envelope)) as JsonObject;
  row.damage(envelope, fixture);
  return envelope;
}

/**
 * The digest a damaged envelope would carry had its writer sealed it, with
 * any field the damage removed or retyped read as empty (the schema refuses
 * such a file whatever its digest).
 *
 * @param envelope - The damaged envelope.
 * @returns Its recomputed digest.
 */
function recomputedDigest(envelope: JsonObject): string {
  const object = (value: Json | undefined): JsonObject =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  const text = (value: Json | undefined): string => (typeof value === "string" ? value : "");
  const addresses = object(envelope.addresses);
  const anchor = object(envelope.chainAnchor);
  const seen = object(anchor.seenBlock);
  const snapshots = object(envelope.snapshots);
  return walletCacheDigest({
    formatVersion: 1,
    networkId: text(envelope.networkId),
    addresses: {
      unshielded: text(addresses.unshielded),
      shielded: text(addresses.shielded),
      dust: text(addresses.dust),
    },
    chainAnchor: {
      genesisHash: text(anchor.genesisHash),
      seenBlock: {
        height: typeof seen.height === "number" ? seen.height : 0,
        hash: text(seen.hash),
      },
    },
    skipLedgerV8DustHistory: envelope.skipLedgerV8DustHistory === true,
    savedAt: text(envelope.savedAt),
    snapshots: {
      shielded: text(snapshots.shielded),
      unshielded: text(snapshots.unshielded),
      dust: text(snapshots.dust),
      transactionHistory: text(snapshots.transactionHistory),
      transactionLifecycle: text(snapshots.transactionLifecycle),
    },
  });
}

describe("the valid fixture", () => {
  it("validates", async () => {
    const result = await validateWalletCache(
      JSON.stringify(fixture.envelope),
      fixture.keys,
      FIXTURE_CONFIG,
      {},
      FIXTURE_CHAIN,
    );
    expect(result).toHaveProperty("snapshots");
  });

  it("changes the file in every applicable damage row, and in no other", () => {
    const unchanged = ALL_ROWS.filter(
      (row) => JSON.stringify(damaged(row)) === JSON.stringify(fixture.envelope),
    ).map((row) => row.name);
    expect(ALL_ROWS).toHaveLength(89);
    expect(new Set(unchanged)).toEqual(NOT_APPLICABLE);
  });
});

describe("a damaged cache as written", () => {
  it.each(ROWS)("refuses $name", async (row) => {
    const result = await validateWalletCache(
      JSON.stringify(damaged(row)),
      fixture.keys,
      FIXTURE_CONFIG,
      {},
      FIXTURE_CHAIN,
    );
    expect(result).toHaveProperty("rejection");
  });

  it.each(TRUNCATIONS)("refuses the file truncated at %d", async (at) => {
    const text = JSON.stringify(fixture.envelope);
    const cut = at < 0 ? text.length + at : at < 1 ? Math.floor(text.length * at) : at;
    const result = await validateWalletCache(
      text.slice(0, cut),
      fixture.keys,
      FIXTURE_CONFIG,
      {},
      FIXTURE_CHAIN,
    );
    expect(result).toMatchObject({ rejection: WalletCacheRejection.Unparseable });
  });
});

describe("a damaged cache with its digest recomputed", () => {
  it.each(RESEALED_ROWS)("$name", async (row) => {
    const envelope = damaged(row);
    envelope.digest = recomputedDigest(envelope);
    const result = await validateWalletCache(
      JSON.stringify(envelope),
      fixture.keys,
      FIXTURE_CONFIG,
      {},
      FIXTURE_CHAIN,
    );
    expect("rejection" in result).toBe(!DIGEST_ONLY.has(row.name));
  });
});
