// The on-disk wallet sync cache: where a wallet's cache file lives, what
// makes it trustworthy, and how it is written while the wallet runs.
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { redactUrlQuery } from "@sig-net/midnight";
import { Either, Schema } from "effect";

import { envOrUndefined } from "./env.ts";
import { isLocalStandaloneNetwork, type NetworkId } from "./network-id.ts";
import type { WalletAddresses } from "./wallet.ts";

/**
 * One wallet's cache file: the wallet SDK's own snapshots of the three
 * sub-wallets, the transaction history and the transaction lifecycle records,
 * wrapped with the facts {@link checkWalletCacheEnvelope} and
 * {@link checkWalletCacheChain} validate before a restore, and sealed by a
 * SHA-256 `digest` over everything else (see {@link walletCacheDigest}). It
 * holds no seed and no secret key, but it does reveal the wallet's balances.
 */
export type WalletCacheEnvelope = Schema.Schema.Type<typeof WALLET_CACHE_ENVELOPE_SCHEMA>;

/** A cache envelope before it is sealed with its digest. */
export type WalletCacheFields = Omit<WalletCacheEnvelope, "digest">;

/** The cache file format this build writes and the only one it reads. */
export const WALLET_CACHE_FORMAT_VERSION = 1;

const CHAIN_BLOCK_SCHEMA = Schema.Struct({
  height: Schema.NonNegativeInt,
  hash: Schema.NonEmptyString,
});

const WALLET_CACHE_ENVELOPE_SCHEMA = Schema.Struct({
  formatVersion: Schema.Literal(WALLET_CACHE_FORMAT_VERSION),
  networkId: Schema.NonEmptyString,
  addresses: Schema.Struct({
    unshielded: Schema.NonEmptyString,
    shielded: Schema.NonEmptyString,
    dust: Schema.NonEmptyString,
  }),
  chainAnchor: Schema.Struct({ genesisHash: Schema.NonEmptyString, seenBlock: CHAIN_BLOCK_SCHEMA }),
  skipLedgerV8DustHistory: Schema.Boolean,
  savedAt: Schema.NonEmptyString,
  snapshots: Schema.Struct({
    shielded: Schema.NonEmptyString,
    unshielded: Schema.NonEmptyString,
    dust: Schema.NonEmptyString,
    transactionHistory: Schema.NonEmptyString,
    transactionLifecycle: Schema.NonEmptyString,
  }),
  digest: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
});

/**
 * The label's runs of letters and digits.
 *
 * @param label - The wallet's role name.
 * @returns The runs, in order.
 * @throws {Error} If there are none.
 */
function labelWords(label: string): string[] {
  const words = label.split(/[^A-Za-z0-9]+/).filter((word) => word !== "");
  if (words.length === 0) {
    throw new Error(`wallet label "${label}" holds no letter or digit to name its cache after`);
  }
  return words;
}

/** A block the indexer reports, by height and hash. */
export type ChainBlock = WalletCacheEnvelope["chainAnchor"]["seenBlock"];

/** Which chain a cache was written on: its genesis block and one block the wallet's chain had reached. */
export type WalletChainAnchor = WalletCacheEnvelope["chainAnchor"];

/** The wallet SDK's serialised state, one string per part, as {@link WalletCacheEnvelope} carries it. */
export type WalletCacheSnapshots = WalletCacheEnvelope["snapshots"];

/** Whether a cache path came from the wallet's environment variable or the default location. */
export enum WalletCachePathSource {
  Default = "default",
  Explicit = "explicit",
}

/** Where one wallet's cache file lives, and how that was decided. */
export interface WalletCacheLocation {
  /** The cache file's absolute path. */
  readonly path: string;
  /** Whether the path is the default one or named by {@link envVar}. */
  readonly source: WalletCachePathSource;
  /** The environment variable that names this wallet's cache path. */
  readonly envVar: string;
  /** The path as logged: relative to the repository root when it lies inside it. */
  readonly displayPath: string;
}

/**
 * The environment variable naming a wallet's cache path, derived from its
 * label: upper case, every run of other characters as `_`, then
 * `_WALLET_CACHE_PATH` (`mpc responder` gives `MPC_RESPONDER_WALLET_CACHE_PATH`).
 *
 * @param label - The wallet's role name.
 * @returns The variable's name.
 * @throws {Error} If the label holds no letter or digit.
 */
export function walletCacheEnvVar(label: string): string {
  return `${labelWords(label).join("_").toUpperCase()}_WALLET_CACHE_PATH`;
}

/**
 * The first directory at or above `startDirectory` holding a `.git` entry,
 * a directory in a plain checkout and a file in a git worktree.
 *
 * @param startDirectory - The directory to start the walk from.
 * @returns The repository root, or undefined when no ancestor holds `.git`.
 */
export function findRepositoryRoot(startDirectory: string): string | undefined {
  let directory = resolve(startDirectory);
  for (;;) {
    if (existsSync(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * A cache path as logged.
 *
 * @param path - The absolute path.
 * @param root - The repository root, when there is one.
 * @returns The path relative to `root` when inside it, else the path itself.
 */
function displayPath(path: string, root: string | undefined): string {
  if (root === undefined) return path;
  const inside = relative(root, path);
  return inside.startsWith(`..${sep}`) || isAbsolute(inside) ? path : inside;
}

/**
 * Decide where a wallet's cache file lives. The wallet's
 * {@link walletCacheEnvVar} names an explicit path, resolved against the
 * repository root when relative. Otherwise the default path is
 * `.wallet-cache-<networkId>-<fingerprint>.json` in the repository root,
 * where the fingerprint is the first 12 hex digits of the SHA-256 of the
 * unshielded address, so one seed keeps one file under every label that
 * opens it.
 *
 * @param env - The environment holding the wallet's cache path variable.
 * @param label - The wallet's role name, which names its path variable.
 * @param networkId - The network the wallet syncs on.
 * @param addresses - The wallet's addresses, fingerprinted into the default name.
 * @param workingDirectory - Where the repository root search starts.
 * @returns The location, or undefined when no path is named and no repository root exists.
 * @throws {Error} If the label holds no letter or digit.
 */
export function resolveWalletCacheLocation(
  env: Record<string, string | undefined>,
  label: string,
  networkId: NetworkId,
  addresses: WalletAddresses,
  workingDirectory: string,
): WalletCacheLocation | undefined {
  const envVar = walletCacheEnvVar(label);
  const root = findRepositoryRoot(workingDirectory);
  const named = envOrUndefined(env, envVar);
  if (named !== undefined) {
    const path = isAbsolute(named) ? named : resolve(root ?? workingDirectory, named);
    return {
      path,
      source: WalletCachePathSource.Explicit,
      envVar,
      displayPath: displayPath(path, root),
    };
  }
  if (root === undefined) return undefined;
  const fingerprint = createHash("sha256").update(addresses.unshielded).digest("hex").slice(0, 12);
  const path = join(root, `.wallet-cache-${networkId}-${fingerprint}.json`);
  return {
    path,
    source: WalletCachePathSource.Default,
    envVar,
    displayPath: displayPath(path, root),
  };
}

/**
 * The SHA-256 digest that seals a cache: over a canonical serialisation of
 * every envelope field in a fixed order, so any edit to the file's header
 * or to any snapshot changes it.
 *
 * @param fields - The envelope without its digest.
 * @returns The digest, as lowercase hex.
 */
export function walletCacheDigest(fields: WalletCacheFields): string {
  const { addresses, chainAnchor, snapshots } = fields;
  const canonical = JSON.stringify([
    fields.formatVersion,
    fields.networkId,
    [addresses.unshielded, addresses.shielded, addresses.dust],
    [chainAnchor.genesisHash, chainAnchor.seenBlock.height, chainAnchor.seenBlock.hash],
    fields.skipLedgerV8DustHistory,
    fields.savedAt,
    [
      snapshots.shielded,
      snapshots.unshielded,
      snapshots.dust,
      snapshots.transactionHistory,
      snapshots.transactionLifecycle,
    ],
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Seal an envelope with its {@link walletCacheDigest}, replacing any digest it carries.
 *
 * @param fields - The envelope's fields.
 * @returns The sealed envelope, ready to write.
 */
export function sealWalletCache(fields: WalletCacheFields): WalletCacheEnvelope {
  return { ...fields, digest: walletCacheDigest(fields) };
}

/** Why a cache file is refused. */
export enum WalletCacheRejection {
  Unparseable = "unparseable",
  UnsupportedFormat = "unsupported-format",
  DigestMismatch = "digest-mismatch",
  NetworkMismatch = "network-mismatch",
  DustHistorySettingMismatch = "dust-history-setting-mismatch",
  IdentityMismatch = "identity-mismatch",
  InconsistentSnapshots = "inconsistent-snapshots",
  ChainMismatch = "chain-mismatch",
  SnapshotUnreadable = "snapshot-unreadable",
}

/** A refused cache: the rejection and what exactly disagreed. */
export interface WalletCacheRefusal {
  /** The kind of refusal. */
  readonly rejection: WalletCacheRejection;
  /** What disagreed, for the log line or error message. */
  readonly detail: string;
}

/** The facts about the wallet being opened that a cache must agree with. */
export interface WalletCacheIdentity {
  /** The network the wallet syncs on. */
  readonly networkId: NetworkId;
  /** The wallet's addresses, derived from its seed. */
  readonly addresses: WalletAddresses;
  /** The shielded coin public key, as hex. */
  readonly coinPublicKey: string;
  /** The shielded encryption public key, as hex. */
  readonly encryptionPublicKey: string;
  /** The DUST public key. */
  readonly dustPublicKey: bigint;
  /** Whether the DUST wallet skips the Ledger 8 DUST history, which a restore cannot change. */
  readonly skipLedgerV8DustHistory: boolean;
}

const VERSIONED_SCHEMA = Schema.Struct({ formatVersion: Schema.Unknown });

const UTXO_SCHEMA = Schema.Struct({
  owner: Schema.String,
  intentHash: Schema.String,
  outputNo: Schema.Number,
});

const SNAPSHOT_FORMAT_FIELDS = {
  version: Schema.NonEmptyString,
  writtenBy: Schema.NonEmptyString,
};

const SHIELDED_FACTS_SCHEMA = Schema.parseJson(
  Schema.Struct({
    ...SNAPSHOT_FORMAT_FIELDS,
    publicKeys: Schema.Struct({ coinPublicKey: Schema.String, encryptionPublicKey: Schema.String }),
    networkId: Schema.String,
    offset: Schema.BigInt,
  }),
);
const UNSHIELDED_FACTS_SCHEMA = Schema.parseJson(
  Schema.Struct({
    ...SNAPSHOT_FORMAT_FIELDS,
    publicKey: Schema.Struct({ address: Schema.String }),
    networkId: Schema.String,
    appliedId: Schema.BigInt,
    state: Schema.Struct({
      availableUtxos: Schema.Array(Schema.Struct({ utxo: UTXO_SCHEMA })),
      pendingUtxos: Schema.Array(Schema.Struct({ utxo: Schema.Struct({ utxo: UTXO_SCHEMA }) })),
    }),
  }),
);
const HISTORY_FACTS_SCHEMA = Schema.parseJson(
  Schema.Struct({
    version: Schema.NonEmptyString,
    entries: Schema.Array(
      Schema.Struct({
        status: Schema.optional(Schema.String),
        lifecycle: Schema.Struct({ status: Schema.String }),
        unshielded: Schema.optional(
          Schema.Struct({
            id: Schema.Number,
            createdUtxos: Schema.Array(
              Schema.Struct({
                owner: Schema.String,
                intentHash: Schema.String,
                outputIndex: Schema.Number,
              }),
            ),
            spentUtxos: Schema.Array(
              Schema.Struct({ intentHash: Schema.String, outputIndex: Schema.Number }),
            ),
          }),
        ),
      }),
    ),
  }),
);
const DUST_FACTS_SCHEMA = Schema.parseJson(
  Schema.Struct({
    ...SNAPSHOT_FORMAT_FIELDS,
    publicKey: Schema.Struct({ publicKey: Schema.String }),
    networkId: Schema.String,
    offset: Schema.BigInt,
  }),
);

/** What the sub-wallet snapshots record about themselves, read for the cache's cross-checks. */
interface InnerSnapshotFacts {
  readonly coinPublicKey: string;
  readonly encryptionPublicKey: string;
  readonly unshieldedAddress: string;
  /** Every UTXO the unshielded snapshot holds, available or booked. */
  readonly utxos: readonly { readonly owner: string; readonly key: string }[];
  /** The unshielded side of every finalized transaction history entry. */
  readonly finalizedUnshielded: readonly {
    readonly succeeded: boolean;
    readonly failed: boolean;
    readonly id: number;
    readonly created: readonly { readonly owner: string; readonly key: string }[];
    readonly spent: readonly string[];
  }[];
  readonly dustPublicKey: string;
  readonly networkIds: {
    readonly shielded: string;
    readonly unshielded: string;
    readonly dust: string;
  };
  /** The shielded wallet's cursor, an indexer ledger event id. */
  readonly shieldedEventCursor: bigint;
  /** The DUST wallet's cursor, an indexer ledger event id. */
  readonly dustEventCursor: bigint;
  /** The unshielded wallet's cursor, an indexer transaction id. */
  readonly unshieldedTransactionCursor: bigint;
}

/**
 * Read the facts each sub-wallet snapshot records about itself.
 *
 * @param snapshots - The cache's sub-wallet snapshots.
 * @returns The facts, or the refusal naming the snapshot that lacks them.
 */
function innerSnapshotFacts(
  snapshots: WalletCacheSnapshots,
): InnerSnapshotFacts | WalletCacheRefusal {
  const shielded = Schema.decodeUnknownEither(SHIELDED_FACTS_SCHEMA)(snapshots.shielded);
  if (Either.isLeft(shielded)) return unreadableFacts("shielded", shielded.left.message);
  const unshielded = Schema.decodeUnknownEither(UNSHIELDED_FACTS_SCHEMA)(snapshots.unshielded);
  if (Either.isLeft(unshielded)) return unreadableFacts("unshielded", unshielded.left.message);
  const dust = Schema.decodeUnknownEither(DUST_FACTS_SCHEMA)(snapshots.dust);
  if (Either.isLeft(dust)) return unreadableFacts("dust", dust.left.message);
  const history = Schema.decodeUnknownEither(HISTORY_FACTS_SCHEMA)(snapshots.transactionHistory);
  if (Either.isLeft(history)) return unreadableFacts("transaction history", history.left.message);
  const { state } = unshielded.right;
  const utxoKey = (intentHash: string, output: number): string => `${intentHash}#${String(output)}`;
  return {
    coinPublicKey: shielded.right.publicKeys.coinPublicKey,
    encryptionPublicKey: shielded.right.publicKeys.encryptionPublicKey,
    unshieldedAddress: unshielded.right.publicKey.address,
    utxos: [
      ...state.availableUtxos.map((entry) => entry.utxo),
      ...state.pendingUtxos.map((entry) => entry.utxo.utxo),
    ].map((utxo) => ({ owner: utxo.owner, key: utxoKey(utxo.intentHash, utxo.outputNo) })),
    finalizedUnshielded: history.right.entries.flatMap((entry) =>
      entry.lifecycle.status === "finalized" && entry.unshielded !== undefined
        ? [
            {
              succeeded: entry.status === "SUCCESS",
              failed: entry.status === "FAILURE",
              id: entry.unshielded.id,
              created: entry.unshielded.createdUtxos.map((utxo) => ({
                owner: utxo.owner,
                key: utxoKey(utxo.intentHash, utxo.outputIndex),
              })),
              spent: entry.unshielded.spentUtxos.map((utxo) =>
                utxoKey(utxo.intentHash, utxo.outputIndex),
              ),
            },
          ]
        : [],
    ),
    dustPublicKey: dust.right.publicKey.publicKey,
    networkIds: {
      shielded: shielded.right.networkId,
      unshielded: unshielded.right.networkId,
      dust: dust.right.networkId,
    },
    shieldedEventCursor: shielded.right.offset,
    dustEventCursor: dust.right.offset,
    unshieldedTransactionCursor: unshielded.right.appliedId,
  };
}

/**
 * The refusal for a sub-wallet snapshot missing the facts the cross-checks read.
 *
 * @param part - The snapshot's name.
 * @param cause - What the schema found missing.
 * @returns The refusal.
 */
function unreadableFacts(part: string, cause: string): WalletCacheRefusal {
  return {
    rejection: WalletCacheRejection.Unparseable,
    detail: `the ${part} snapshot does not record its own identity, network and cursor: ${cause}`,
  };
}

/**
 * Check a cache file's text against the wallet being opened, without network
 * access, in this order. It parses as this build's format with every field
 * present, non-empty and nothing else, or is refused as unparseable (a
 * missing digest included). Its digest seals every other field. Its
 * network, DUST history setting and addresses, the network each sub-wallet
 * snapshot records, the public keys inside each snapshot and the owner of
 * every unshielded UTXO all match the wallet. Its unshielded UTXOs agree
 * with its transaction history. The wallet SDK restores another seed's or
 * network's snapshot without complaint, so the inner facts are checked here.
 *
 * @param text - The cache file's contents.
 * @param identity - The wallet being opened.
 * @returns The envelope when every check passes, else the first refusal.
 */
export function checkWalletCacheEnvelope(
  text: string,
  identity: WalletCacheIdentity,
): { readonly envelope: WalletCacheEnvelope } | WalletCacheRefusal {
  const parsed = Schema.decodeUnknownEither(Schema.parseJson(VERSIONED_SCHEMA))(text);
  if (Either.isLeft(parsed)) {
    return { rejection: WalletCacheRejection.Unparseable, detail: parsed.left.message };
  }
  if (parsed.right.formatVersion !== WALLET_CACHE_FORMAT_VERSION) {
    return {
      rejection: WalletCacheRejection.UnsupportedFormat,
      detail: `format ${JSON.stringify(parsed.right.formatVersion)}, this build reads ${String(WALLET_CACHE_FORMAT_VERSION)}`,
    };
  }
  const decoded = Schema.decodeUnknownEither(Schema.parseJson(WALLET_CACHE_ENVELOPE_SCHEMA))(text, {
    onExcessProperty: "error",
  });
  if (Either.isLeft(decoded)) {
    return { rejection: WalletCacheRejection.Unparseable, detail: decoded.left.message };
  }
  const envelope = decoded.right;
  if (walletCacheDigest(envelope) !== envelope.digest) {
    return {
      rejection: WalletCacheRejection.DigestMismatch,
      detail: "the file's contents do not match the digest it was written with",
    };
  }
  const networkId: string = identity.networkId;
  if (envelope.networkId !== networkId) {
    return {
      rejection: WalletCacheRejection.NetworkMismatch,
      detail: `written for ${envelope.networkId}, opening on ${networkId}`,
    };
  }
  if (envelope.skipLedgerV8DustHistory !== identity.skipLedgerV8DustHistory) {
    return {
      rejection: WalletCacheRejection.DustHistorySettingMismatch,
      detail: `written with skipLedgerV8DustHistory ${String(envelope.skipLedgerV8DustHistory)}, opening with ${String(identity.skipLedgerV8DustHistory)}`,
    };
  }
  const inner = innerSnapshotFacts(envelope.snapshots);
  if ("rejection" in inner) return inner;
  const foreignNetworks = Object.entries(inner.networkIds).filter(([, id]) => id !== networkId);
  if (foreignNetworks.length > 0) {
    return {
      rejection: WalletCacheRejection.NetworkMismatch,
      detail: `${foreignNetworks.map(([part, id]) => `the ${part} snapshot was written for ${id}`).join(", ")}, opening on ${networkId}`,
    };
  }
  const mismatches = [
    envelope.addresses.unshielded === identity.addresses.unshielded
      ? []
      : ["envelope unshielded address"],
    envelope.addresses.shielded === identity.addresses.shielded
      ? []
      : ["envelope shielded address"],
    envelope.addresses.dust === identity.addresses.dust ? [] : ["envelope dust address"],
    inner.coinPublicKey === identity.coinPublicKey ? [] : ["shielded snapshot coin public key"],
    inner.encryptionPublicKey === identity.encryptionPublicKey
      ? []
      : ["shielded snapshot encryption public key"],
    inner.unshieldedAddress === identity.addresses.unshielded
      ? []
      : ["unshielded snapshot address"],
    inner.utxos.every((utxo) => utxo.owner === identity.addresses.unshielded)
      ? []
      : ["unshielded UTXO owner"],
    inner.dustPublicKey === identity.dustPublicKey.toString() ? [] : ["dust snapshot public key"],
  ].flat();
  if (mismatches.length > 0) {
    return {
      rejection: WalletCacheRejection.IdentityMismatch,
      detail: `another wallet's cache, mismatched: ${mismatches.join(", ")}`,
    };
  }
  const inconsistencies = unshieldedInconsistencies(inner, identity.addresses.unshielded);
  if (inconsistencies.length > 0) {
    return {
      rejection: WalletCacheRejection.InconsistentSnapshots,
      detail: `the unshielded snapshot and the transaction history disagree: ${inconsistencies.join(", ")}`,
    };
  }
  return { envelope };
}

/**
 * Where the unshielded snapshot and the transaction history disagree: the
 * unshielded cursor is behind a transaction the history finalized, a UTXO
 * the history shows created for this address and never spent is missing
 * from the snapshot, or the snapshot holds a UTXO no finalized transaction
 * created. The unshielded wallet syncs its address's whole history, so the
 * two describe the same transactions.
 *
 * @param inner - The snapshots' facts.
 * @param address - The wallet's unshielded address.
 * @returns One description per disagreement, empty when they agree.
 */
function unshieldedInconsistencies(inner: InnerSnapshotFacts, address: string): string[] {
  const settled = inner.finalizedUnshielded.filter((entry) => !entry.failed);
  const newest = Math.max(0, ...settled.map((entry) => entry.id));
  const spent = new Set(settled.flatMap((entry) => entry.spent));
  const created = new Set(
    settled
      .flatMap((entry) => entry.created)
      .filter((utxo) => utxo.owner === address)
      .map((utxo) => utxo.key),
  );
  const held = new Set(inner.utxos.map((utxo) => utxo.key));
  const lost = settled
    .filter((entry) => entry.succeeded)
    .flatMap((entry) => entry.created)
    .filter((utxo) => utxo.owner === address && !spent.has(utxo.key) && !held.has(utxo.key));
  const unexplained = [...held].filter((key) => !created.has(key));
  return [
    inner.unshieldedTransactionCursor < BigInt(newest)
      ? [
          `cursor ${String(inner.unshieldedTransactionCursor)} behind finalized transaction ${String(newest)}`,
        ]
      : [],
    lost.length > 0 ? [`${String(lost.length)} unspent UTXO(s) of the history missing`] : [],
    unexplained.length > 0
      ? [`${String(unexplained.length)} UTXO(s) no finalized transaction created`]
      : [],
  ].flat();
}

/**
 * Reads one block from the chain the wallet syncs on.
 *
 * @param height - The block height, or undefined for the latest block.
 * @returns The block, or undefined when the chain has no block at that height.
 * @throws {Error} If the chain cannot be reached or answers in an unexpected shape.
 */
export type ChainBlockReader = (height?: number) => Promise<ChainBlock | undefined>;

/** The chain's tip as a cache's cursors are bounded by it. */
export interface ChainTip {
  /** The latest block. */
  readonly block: ChainBlock;
  /** The newest transaction id near the tip, which bounds the unshielded wallet's cursor, or undefined when none was found. */
  readonly lastTransactionId: bigint | undefined;
  /** The newest ledger event id near the tip, which bounds the shielded and DUST cursors, or undefined when none was found. */
  readonly lastLedgerEventId: bigint | undefined;
}

/** The chain reads a cache is validated and anchored with. */
export interface WalletCacheChain {
  /** Reads one block by height, or the latest. */
  readonly readBlock: ChainBlockReader;
  /**
   * Read the chain's tip.
   *
   * @returns The tip.
   * @throws {Error} If the chain cannot be reached.
   */
  readTip(): Promise<ChainTip>;
}

/** How many blocks back from the tip {@link indexerWalletCacheChain} looks for the newest transaction. */
const TIP_TRANSACTION_SEARCH_DEPTH = 64;

const TIP_BLOCK_SCHEMA = Schema.Struct({
  height: Schema.NonNegativeInt,
  hash: Schema.NonEmptyString,
  transactions: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      zswapLedgerEvents: Schema.Array(Schema.Struct({ maxId: Schema.Number })),
      dustLedgerEvents: Schema.Array(Schema.Struct({ maxId: Schema.Number })),
    }),
  ),
});

/**
 * A {@link WalletCacheChain} over an indexer's GraphQL `block` query. The
 * indexer ingests finalized blocks only, so every block it reports is final.
 * The tip's transaction and ledger event ids come from the newest block
 * within {@link TIP_TRANSACTION_SEARCH_DEPTH} blocks of the tip that holds a
 * transaction, and stay undefined on a chain quieter than that.
 *
 * @param indexerUrl - The indexer's HTTP GraphQL endpoint.
 * @returns The chain reads.
 */
export function indexerWalletCacheChain(indexerUrl: string): WalletCacheChain {
  const readTipBlock = (height?: number) =>
    indexerBlockQuery(
      indexerUrl,
      "query WalletCacheTip($offset: BlockOffset) { block(offset: $offset) { height hash transactions { id zswapLedgerEvents { maxId } dustLedgerEvents { maxId } } } }",
      height,
      TIP_BLOCK_SCHEMA,
    );
  return {
    readBlock: (height) =>
      indexerBlockQuery(
        indexerUrl,
        "query WalletCacheBlock($offset: BlockOffset) { block(offset: $offset) { height hash } }",
        height,
        CHAIN_BLOCK_SCHEMA,
      ),
    async readTip() {
      const tip = await readTipBlock();
      if (tip === undefined) {
        throw new Error(`indexer ${redactUrlQuery(indexerUrl)} reports no latest block`);
      }
      let lastTransactionId: bigint | undefined;
      let lastLedgerEventId: bigint | undefined;
      for (
        let depth = 0;
        depth < TIP_TRANSACTION_SEARCH_DEPTH && tip.height - depth >= 0;
        depth++
      ) {
        const block = depth === 0 ? tip : await readTipBlock(tip.height - depth);
        const transactions = block?.transactions ?? [];
        if (transactions.length === 0) continue;
        lastTransactionId = BigInt(Math.max(...transactions.map((transaction) => transaction.id)));
        const eventIds = transactions.flatMap((transaction) =>
          [...transaction.zswapLedgerEvents, ...transaction.dustLedgerEvents].map(
            (event) => event.maxId,
          ),
        );
        lastLedgerEventId = eventIds.length === 0 ? undefined : BigInt(Math.max(...eventIds));
        break;
      }
      return {
        block: { height: tip.height, hash: tip.hash },
        lastTransactionId,
        lastLedgerEventId,
      };
    },
  };
}

/**
 * Run one `block` query against an indexer.
 *
 * @param indexerUrl - The indexer's HTTP GraphQL endpoint.
 * @param query - The query, taking an optional `$offset: BlockOffset`.
 * @param height - The block height, or undefined for the latest block.
 * @param blockSchema - The shape of the block the query selects.
 * @returns The block, or undefined when the chain has no block at that height.
 * @throws {Error} If the indexer cannot be reached, refuses the query or answers in another shape.
 */
async function indexerBlockQuery<A, I>(
  indexerUrl: string,
  query: string,
  height: number | undefined,
  blockSchema: Schema.Schema<A, I>,
): Promise<A | undefined> {
  const response = await fetch(indexerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: height === undefined ? {} : { offset: { height } } }),
  }).catch((error: unknown) => {
    throw new Error(`indexer ${redactUrlQuery(indexerUrl)} cannot be reached for the block query`, {
      cause: error,
    });
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `indexer ${redactUrlQuery(indexerUrl)} answered the block query with HTTP ${String(response.status)}`,
    );
  }
  const answer = Schema.decodeUnknownSync(
    Schema.parseJson(
      Schema.Struct({
        data: Schema.optional(Schema.NullOr(Schema.Struct({ block: Schema.NullOr(blockSchema) }))),
        errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
      }),
    ),
  )(text);
  const errors = answer.errors ?? [];
  if (errors.length > 0) {
    throw new Error(
      `indexer ${redactUrlQuery(indexerUrl)} refused the block query: ${errors.map((error) => error.message).join(", ")}`,
    );
  }
  return answer.data?.block ?? undefined;
}

/**
 * The anchor a cache written now records: the genesis block's hash and the
 * latest block the indexer reports. A restarted local chain repeats its
 * genesis block, so only a later block tells one run of it from the next.
 *
 * @param chain - Reads the wallet's chain.
 * @returns The anchor, or undefined while the indexer's latest block is the genesis block.
 * @throws {Error} If the chain cannot be reached or reports no genesis or latest block.
 */
export async function readChainAnchor(
  chain: WalletCacheChain,
): Promise<WalletChainAnchor | undefined> {
  const [genesis, latest] = await Promise.all([chain.readBlock(0), chain.readBlock()]);
  if (genesis === undefined || latest === undefined) {
    throw new Error("the indexer reports no genesis or latest block to anchor the wallet cache to");
  }
  if (latest.height === 0) return undefined;
  return { genesisHash: genesis.hash, seenBlock: latest };
}

/** How far a ledger event cursor may run past the newest event id, as a cursor can name the next event to read. */
const LEDGER_EVENT_CURSOR_SLACK = 1n;

/**
 * Check a cache against the chain the wallet syncs on now: the chain holds
 * the anchor's genesis, the seen block is past genesis and at its height on
 * the chain, which a wiped and restarted chain does not hold, and no
 * sub-wallet cursor is past the tip (the shielded and DUST cursors against
 * the newest ledger event id, the unshielded cursor against the newest
 * transaction id), which a doctored file or another chain's cache can be.
 * A tip below the seen block refuses the cache on the local standalone
 * stack, whose chain restarts under the same genesis, and throws on a
 * deployed network, where only an indexer still catching up explains it.
 *
 * @param envelope - A cache {@link checkWalletCacheEnvelope} accepted.
 * @param chain - Reads the wallet's chain.
 * @returns The refusal, or undefined when the cache is on this chain.
 * @throws {Error} If the chain cannot be reached or a deployed network's indexer
 *   is behind the seen block, neither of which says anything about the cache.
 */
export async function checkWalletCacheChain(
  envelope: WalletCacheEnvelope,
  chain: WalletCacheChain,
): Promise<WalletCacheRefusal | undefined> {
  const { genesisHash, seenBlock } = envelope.chainAnchor;
  const [genesis, seen, tip] = await Promise.all([
    chain.readBlock(0),
    chain.readBlock(seenBlock.height),
    chain.readTip(),
  ]);
  const beyond = (detail: string): WalletCacheRefusal => ({
    rejection: WalletCacheRejection.ChainMismatch,
    detail,
  });
  if (genesis?.hash !== genesisHash) {
    return beyond(`the chain's genesis is not ${genesisHash}`);
  }
  if (seenBlock.height === 0) {
    return beyond("the seen block is the genesis block, which a restarted chain repeats");
  }
  if (seenBlock.height > tip.block.height) {
    const behind = `seen block ${String(seenBlock.height)} is past the tip at ${String(tip.block.height)}`;
    if (isLocalStandaloneNetwork(envelope.networkId)) return beyond(behind);
    throw new Error(
      `the wallet cache's ${behind} on ${envelope.networkId}: the indexer is still catching up, retry once it has`,
    );
  }
  if (seen?.hash !== seenBlock.hash) {
    return beyond(
      `the chain holds no block ${String(seenBlock.height)} ${seenBlock.hash} under genesis ${genesisHash}`,
    );
  }
  const inner = innerSnapshotFacts(envelope.snapshots);
  if ("rejection" in inner) return inner;
  const eventBound =
    tip.lastLedgerEventId === undefined
      ? undefined
      : tip.lastLedgerEventId + LEDGER_EVENT_CURSOR_SLACK;
  const pastTip = [
    eventBound !== undefined && inner.shieldedEventCursor > eventBound
      ? [`shielded cursor ${String(inner.shieldedEventCursor)}`]
      : [],
    eventBound !== undefined && inner.dustEventCursor > eventBound
      ? [`dust cursor ${String(inner.dustEventCursor)}`]
      : [],
    tip.lastTransactionId !== undefined && inner.unshieldedTransactionCursor > tip.lastTransactionId
      ? [`unshielded cursor ${String(inner.unshieldedTransactionCursor)}`]
      : [],
  ].flat();
  if (pastTip.length > 0) {
    return beyond(
      `${pastTip.join(", ")} past the chain's newest ledger event ${String(tip.lastLedgerEventId)} or transaction ${String(tip.lastTransactionId)}`,
    );
  }
  return undefined;
}

/**
 * A refusal's detail on one line: for a multi-line parse failure tree, the
 * field path it descends through followed by its innermost line, which
 * names the actual cause.
 *
 * @param refusal - The refusal to describe.
 * @returns The detail on one line.
 */
function refusalCause(refusal: WalletCacheRefusal): string {
  const lines = refusal.detail
    .trimEnd()
    .split("\n")
    .map((line) => line.replace(/^[\s─-╿]+/u, ""));
  const innermost = lines.at(-1) ?? refusal.detail;
  const path = lines.filter((line) => /^\[.*\]$/u.test(line)).join("");
  return path === "" ? innermost : `${path} ${innermost}`;
}

/** A cache file the wallet was told to use explicitly, refused. */
export class WalletCacheInvalidError extends Error {
  /**
   * @param location - The refused cache's location.
   * @param refusal - Why it was refused.
   */
  constructor(
    readonly location: WalletCacheLocation,
    readonly refusal: WalletCacheRefusal,
  ) {
    super(
      `${location.envVar} names ${location.path}, which holds an invalid wallet cache ` +
        `(${refusal.rejection}): ${refusalCause(refusal)}. Delete the file or unset ${location.envVar}.`,
    );
    this.name = "WalletCacheInvalidError";
  }
}

/**
 * Read a wallet's cache file, logging when there is none.
 *
 * @param location - Where the cache file lives.
 * @param label - The wallet's role name, for the log line.
 * @returns The file's text, or undefined when the file does not exist.
 * @throws {Error} If the file exists but cannot be read.
 */
export async function readWalletCacheText(
  location: WalletCacheLocation,
  label: string,
): Promise<string | undefined> {
  try {
    return await readFile(location.path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    console.log(`${label} wallet: no cache at ${location.displayPath}, syncing from scratch`);
    return undefined;
  }
}

/**
 * Act on a refused cache: delete a default-path file and log the drop, or
 * throw for an explicit path.
 *
 * @param location - The refused cache's location.
 * @param refusal - Why it was refused.
 * @param label - The wallet's role name, for the log line.
 * @returns Undefined, once a default-path file is gone.
 * @throws {WalletCacheInvalidError} If the path was named explicitly.
 */
export async function refuseWalletCache(
  location: WalletCacheLocation,
  refusal: WalletCacheRefusal,
  label: string,
): Promise<undefined> {
  if (location.source === WalletCachePathSource.Explicit) {
    throw new WalletCacheInvalidError(location, refusal);
  }
  await rm(location.path, { force: true });
  console.log(
    `${label} wallet: dropped cache ${location.displayPath} (${refusal.rejection}: ${refusalCause(refusal)}), syncing from scratch`,
  );
  return undefined;
}

/**
 * Write a cache file atomically: a uniquely named temporary file beside it,
 * created with mode 0600, then renamed over the target, so a reader or a
 * concurrent writer never sees a partial file.
 *
 * @param path - The cache file's path.
 * @param envelope - The cache to write.
 * @throws {Error} If the temporary file cannot be written or renamed, leaving the target untouched.
 */
export async function writeWalletCacheAtomically(
  path: string,
  envelope: WalletCacheEnvelope,
): Promise<void> {
  const temporary = `${path}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(envelope), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** How often a {@link WalletCacheWriter} snapshots a running wallet, in milliseconds. */
export const WALLET_CACHE_WRITE_INTERVAL_MS = 10_000;

/**
 * Whether two captures hold the same state.
 *
 * @param a - One capture.
 * @param b - The other.
 * @returns Whether every part is equal.
 */
function sameSnapshots(a: WalletCacheSnapshots, b: WalletCacheSnapshots): boolean {
  return (
    a.shielded === b.shielded &&
    a.unshielded === b.unshielded &&
    a.dust === b.dust &&
    a.transactionHistory === b.transactionHistory &&
    a.transactionLifecycle === b.transactionLifecycle
  );
}

/**
 * Keeps one running wallet's cache file current: every
 * {@link WALLET_CACHE_WRITE_INTERVAL_MS} it captures the wallet's snapshots
 * and writes them when they differ from the last ones written, so an
 * interrupted sync resumes from at most one interval back. A failed capture
 * or write logs a warning and never interrupts the wallet.
 */
export class WalletCacheWriter {
  private timer: ReturnType<typeof setInterval> | undefined;
  private queue: Promise<boolean> | undefined;

  /**
   * @param location - Where the cache file lives.
   * @param header - Everything the envelope carries besides the snapshots and their time.
   * @param capture - Serialises the running wallet.
   * @param label - The wallet's role name, for warnings.
   * @param lastWritten - The snapshots already on disk, which are not rewritten unchanged.
   */
  constructor(
    private readonly location: WalletCacheLocation,
    private readonly header: Omit<WalletCacheFields, "savedAt" | "snapshots">,
    private readonly capture: () => Promise<WalletCacheSnapshots>,
    private readonly label: string,
    private lastWritten?: WalletCacheSnapshots,
  ) {}

  /** Start writing on the interval, on a timer that never keeps the process alive. */
  start(): void {
    this.timer ??= setInterval(() => {
      if (this.queue === undefined) void this.flush(false);
    }, WALLET_CACHE_WRITE_INTERVAL_MS);
    this.timer.unref();
  }

  /**
   * Capture and write the wallet now, after any write in progress.
   *
   * @param force - Whether to write even when the snapshots equal the last ones written.
   * @returns Whether a file was written, false after a logged failure.
   */
  async flush(force: boolean): Promise<boolean> {
    const write = (this.queue ?? Promise.resolve(false)).then(() => this.write(force));
    this.queue = write;
    try {
      return await write;
    } finally {
      if (this.queue === write) this.queue = undefined;
    }
  }

  /** Stop the interval, then write the wallet one last time if it changed. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.flush(false);
  }

  private async write(force: boolean): Promise<boolean> {
    try {
      const snapshots = await this.capture();
      if (!force && this.lastWritten !== undefined && sameSnapshots(snapshots, this.lastWritten)) {
        return false;
      }
      await writeWalletCacheAtomically(
        this.location.path,
        sealWalletCache({ ...this.header, savedAt: new Date().toISOString(), snapshots }),
      );
      this.lastWritten = snapshots;
      return true;
    } catch (error) {
      console.warn(
        `${this.label} wallet: writing cache ${this.location.displayPath} failed, the sync carries on:`,
        error,
      );
      return false;
    }
  }
}
