// Seed → account construction utilities shared by every wallet host (the UI's
// SeedWallet and the integration tests' buildWallet): key derivation, address
// encoding and WalletFacade wiring. Pure crypto + facade construction — no
// network I/O happens here (the facade connects only when started).
import * as ledger from "@midnight-ntwrk/ledger-v8";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import {
  mergeWalletEntries,
  WalletEntrySchema,
  WalletFacade,
} from "@midnight-ntwrk/wallet-sdk-facade";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import {
  createKeystore,
  PublicKey as UnshieldedPublicKey,
  type UnshieldedKeystore,
  UnshieldedWallet,
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { InMemoryTransactionHistoryStorage } from "@midnight-ntwrk/wallet-sdk-abstractions";
import {
  DustAddress,
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from "@midnight-ntwrk/wallet-sdk-address-format";

import type { MidnightNodeConfig } from "./midnight-node-config.ts";
import type { NetworkId } from "./network-id.ts";
import { parseSeed } from "./seed.ts";

/** The live key material for one account. Reused for signing / balancing. */
export interface AccountKeys {
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
}

/** A wallet's three Midnight addresses, as bech32m strings. */
export interface WalletAddresses {
  unshielded: string; // NIGHT receive address
  shielded: string;
  dust: string;
}

/**
 * The fee settings the facade balances transactions with: it burns
 * `feesWithMargin(params, feeBlocksMargin) + additionalFeeOverhead` per
 * transaction. Exported so dust estimations can use the exact same values
 * (see @nyxels/contract-sdk's DustCostParameters).
 */
export const COST_PARAMETERS: { readonly additionalFeeOverhead: bigint; readonly feeBlocksMargin: number } = {
  additionalFeeOverhead: 300_000_000_000n,
  feeBlocksMargin: 5,
};

/**
 * Parse a seed and derive the three role keys (Zswap / NightExternal / Dust).
 * Pure crypto — no network. This is the step that exercises the ledger WASM.
 */
export function deriveAccountKeys(seed: string, networkId: NetworkId): AccountKeys {
  const { seed: seedBytes } = parseSeed(seed);

  const hd = HDWallet.fromSeed(seedBytes);
  if (hd.type !== "seedOk") throw new Error("HDWallet.fromSeed failed (seedError).");

  const derived = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derived.type !== "keysDerived") throw new Error("deriveKeysAt failed (keyOutOfBounds).");
  hd.hdWallet.clear();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(derived.keys[Roles.NightExternal], networkId);

  return { shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

/** Compute the three bech32m addresses from the keys. Pure — no network. */
export function deriveAddresses(keys: AccountKeys, networkId: NetworkId): WalletAddresses {
  const shieldedAddr = new ShieldedAddress(
    ShieldedCoinPublicKey.fromHexString(keys.shieldedSecretKeys.coinPublicKey),
    ShieldedEncryptionPublicKey.fromHexString(keys.shieldedSecretKeys.encryptionPublicKey),
  );
  return {
    unshielded: keys.unshieldedKeystore.getBech32Address().asString(),
    shielded: MidnightBech32m.encode(networkId, shieldedAddr).asString(),
    dust: DustAddress.encodePublicKey(networkId, keys.dustSecretKey.publicKey),
  };
}

/**
 * Wire up the WalletFacade for the given keys + connection config. This only
 * constructs the three sub-wallets — it does NOT start syncing.
 */
export function initialiseWalletFacade(keys: AccountKeys, config: MidnightNodeConfig): Promise<WalletFacade> {
  return WalletFacade.init({
    configuration: {
      networkId: config.networkId,
      indexerClientConnection: {
        indexerHttpUrl: config.indexerUrl,
        indexerWsUrl: config.indexerWsUrl,
      },
      provingServerUrl: new URL(config.proofServerUrl),
      // The facade talks to the node over WebSocket, so flip http(s) -> ws(s).
      relayURL: new URL(config.nodeUrl.replace(/^http/, "ws")),
      costParameters: COST_PARAMETERS,
      txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    },
    shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(keys.shieldedSecretKeys),
    unshielded: (cfg) =>
      UnshieldedWallet(cfg).startWithPublicKey(UnshieldedPublicKey.fromKeyStore(keys.unshieldedKeystore)),
    dust: (cfg) =>
      DustWallet(cfg).startWithSecretKey(keys.dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
}
