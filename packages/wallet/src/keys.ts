// Seed → account construction: key derivation and address encoding. Pure
// crypto — no network I/O. This is the step that exercises the ledger WASM.
import * as ledger from "@midnightntwrk/ledger-v9";
import {
  DustAddress,
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from "@midnightntwrk/wallet-sdk-address-format";
import { HDWallet, Roles } from "@midnightntwrk/wallet-sdk-hd";
import {
  createKeystore,
  type UnshieldedKeystore,
} from "@midnightntwrk/wallet-sdk-unshielded-wallet";

import type { NetworkId } from "./network-id.ts";
import { parseSeed } from "./seed.ts";
import type { WalletAddresses } from "./Wallet.ts";

/** The live key material for one account. Reused for signing / balancing. */
export interface AccountKeys {
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
}

/**
 * Parse a seed and derive the three role keys (Zswap / NightExternal / Dust).
 * Pure crypto — no network. This is the step that exercises the ledger WASM.
 *
 * @param seed - The wallet seed, as hex or a BIP-39 mnemonic.
 * @param networkId - The network the unshielded keystore is bound to.
 * @returns The Zswap, Dust and unshielded role keys.
 * @throws {Error} If the seed is rejected by the HD wallet or key derivation fails.
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
  const unshieldedKeystore = createKeystore(
    { kind: "schnorr", secret: derived.keys[Roles.NightExternal] },
    networkId,
  );

  return { shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

/**
 * Compute the three bech32m addresses from the keys. Pure — no network.
 *
 * @param keys - The derived role keys.
 * @param networkId - The network the addresses are encoded for.
 * @returns The wallet's unshielded, shielded and dust addresses.
 */
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
