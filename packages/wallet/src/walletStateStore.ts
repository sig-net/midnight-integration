// Persistence hook for a LocalWallet's sync state. Syncing from genesis is
// slow on long chains; the wallet-sdk sub-wallets serialize their state
// (sync position included) and restore from it, resuming where they left
// off. The store decides WHERE the state lives (a file, a bucket, a
// database: the caller's business); the envelope codec here decides WHAT is
// stored: one string carrying the three sub-wallet serializations plus the
// identity fields that make a wrong snapshot fail loudly instead of syncing
// garbage.

import type { NetworkId } from "./network-id.ts";
import { parseRecord, parseString } from "./untrusted-json.ts";

/**
 * Where a `LocalWallet` persists its serialized sync state. Both methods
 * receive the wallet's identifier: its full network-prefixed unshielded
 * NIGHT address (bech32m, so the network is part of the key), letting one
 * store hold many wallets across many networks, segregated by key.
 *
 * The state value is an opaque string owned by this package; a store
 * round-trips it verbatim. Stored state is versioned and validated on
 * load, so a stale or mis-keyed save surfaces as a loud error, at worst
 * costing a delete-and-resync.
 */
export interface WalletStateStore {
  /**
   * The state saved earlier for this wallet.
   *
   * @param unshieldedAddress - The wallet's network-prefixed unshielded NIGHT address.
   * @returns The stored state, or undefined when nothing is stored yet.
   */
  load(unshieldedAddress: string): Promise<string | undefined>;

  /**
   * Persist this wallet's serialized state, replacing any earlier save
   * under the same address.
   *
   * @param unshieldedAddress - The wallet's network-prefixed unshielded NIGHT address.
   * @param state - The opaque serialized state to store.
   */
  save(unshieldedAddress: string, state: string): Promise<void>;
}

/**
 * The three sub-wallet serializations that capture a wallet's sync state,
 * as produced by each sub-wallet's `serializeState()` and consumed by its
 * `restore()`.
 */
export interface WalletStateSnapshot {
  /** The shielded sub-wallet's serialized state. */
  shielded: string;
  /** The unshielded sub-wallet's serialized state. */
  unshielded: string;
  /** The dust sub-wallet's serialized state. */
  dust: string;
}

// Bump on any change to the envelope layout below.
const WALLET_STATE_VERSION = 1;

/**
 * The identity a stored state must match to be restored: the network the
 * wallet connects to and the unshielded address its seed derives. Checked
 * by {@link decodeWalletState} so a snapshot from another network or seed
 * fails loudly instead of restoring the wrong wallet.
 */
export interface WalletStateIdentity {
  /** The network the restoring wallet connects to. */
  networkId: NetworkId;
  /** The restoring wallet's network-prefixed unshielded NIGHT address. */
  unshieldedAddress: string;
}

/**
 * Encode a wallet's sync state into the stored envelope: the snapshot plus
 * the identity fields {@link decodeWalletState} validates.
 *
 * @param snapshot - The three sub-wallet serializations.
 * @param identity - The wallet the snapshot belongs to.
 * @returns The opaque string a {@link WalletStateStore} persists.
 */
export function encodeWalletState(
  snapshot: WalletStateSnapshot,
  identity: WalletStateIdentity,
): string {
  return JSON.stringify({
    version: WALLET_STATE_VERSION,
    networkId: identity.networkId,
    unshieldedAddress: identity.unshieldedAddress,
    shielded: snapshot.shielded,
    unshielded: snapshot.unshielded,
    dust: snapshot.dust,
  });
}

/**
 * Decode and validate a stored envelope. The stored data is untrusted:
 * every field is checked, and the identity fields must match the wallet
 * doing the restoring, so a mis-keyed or stale store surfaces here rather
 * than as a wallet syncing garbage.
 *
 * @param state - The stored string, as returned by a {@link WalletStateStore}.
 * @param expected - The identity of the wallet restoring the state.
 * @returns The validated snapshot.
 * @throws {Error} If the state is corrupt, carries an unknown version, or
 *   belongs to a different network or seed. Deleting the stored state and
 *   resyncing recovers from all of these.
 */
export function decodeWalletState(
  state: string,
  expected: WalletStateIdentity,
): WalletStateSnapshot {
  const context = "stored wallet state";
  let parsed: unknown;
  try {
    parsed = JSON.parse(state) as unknown;
  } catch {
    throw new Error(`${context}: not valid JSON. Delete the stored state and resync.`);
  }
  const record = parseRecord(parsed, context);
  if (record.version !== WALLET_STATE_VERSION) {
    throw new Error(
      `${context}: version ${JSON.stringify(record.version)} is not the supported ` +
        `${String(WALLET_STATE_VERSION)}. Delete the stored state and resync.`,
    );
  }
  const networkId = parseString(record.networkId, `${context} (networkId)`);
  if (networkId !== expected.networkId) {
    throw new Error(
      `${context} belongs to network "${networkId}" but this wallet connects to ` +
        `"${expected.networkId}". Delete the stored state and resync.`,
    );
  }
  const unshieldedAddress = parseString(record.unshieldedAddress, `${context} (unshieldedAddress)`);
  if (unshieldedAddress !== expected.unshieldedAddress) {
    throw new Error(
      `${context} belongs to wallet ${unshieldedAddress} but this wallet is ` +
        `${expected.unshieldedAddress} (a different seed). Delete the stored state and resync.`,
    );
  }
  return {
    shielded: parseString(record.shielded, `${context} (shielded)`),
    unshielded: parseString(record.unshielded, `${context} (unshielded)`),
    dust: parseString(record.dust, `${context} (dust)`),
  };
}
