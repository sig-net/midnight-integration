// Wallet generation: a fresh BIP-39 mnemonic, its seed in hex, and the
// addresses that seed owns on each nominated network. Pure crypto: no network.

import { NETWORK_IDS, type NetworkId } from "./plumbing/network-id.ts";
import { generateMnemonic, ParseError, parseSeed, SeedFormat } from "./plumbing/seed.ts";
import { deriveAccountKeys, deriveAddresses, type WalletAddresses } from "./plumbing/wallet.ts";

/**
 * Generate a wallet from a fresh random 24-word mnemonic.
 *
 * @param networkIds - The networks to derive the wallet's addresses for.
 * @returns The mnemonic, its seed in hex and the addresses per network.
 */
export function generateWallet(networkIds: readonly NetworkId[]): GeneratedWallet {
  return walletFromMnemonic(generateMnemonic(), networkIds);
}

/** A wallet's secret in both spellings and the addresses it owns. */
export interface GeneratedWallet {
  /** The BIP-39 mnemonic, its words separated by single spaces. */
  readonly mnemonic: string;
  /** The mnemonic's 64-byte BIP-39 seed as lowercase hex, which derives the same wallet as the mnemonic. */
  readonly seedHex: string;
  /** The wallet's addresses on each requested network, in the order requested. */
  readonly addresses: readonly NetworkAddresses[];
}

/** One network's encoding of a wallet's addresses. */
export interface NetworkAddresses {
  /** The network the addresses are encoded for. */
  readonly networkId: NetworkId;
  /** The wallet's unshielded, shielded and dust addresses there. */
  readonly addresses: WalletAddresses;
}

/**
 * Describe the wallet a mnemonic owns: its seed in hex and its addresses on
 * each network.
 *
 * @param mnemonic - A BIP-39 mnemonic.
 * @param networkIds - The networks to derive the wallet's addresses for.
 * @returns The mnemonic, its seed in hex and the addresses per network.
 * @throws {ParseError} If `mnemonic` is not a valid BIP-39 mnemonic.
 */
export function walletFromMnemonic(
  mnemonic: string,
  networkIds: readonly NetworkId[],
): GeneratedWallet {
  const { source } = parseSeed(mnemonic);
  if (source.format !== SeedFormat.Mnemonic) {
    throw new ParseError("Expected a BIP-39 mnemonic, got a hex seed.");
  }
  return {
    mnemonic: mnemonic.trim().split(/\s+/).join(" "),
    seedHex: source.seedHex,
    addresses: networkIds.map((networkId) => ({
      networkId,
      addresses: deriveAddresses(deriveAccountKeys(mnemonic, networkId), networkId),
    })),
  };
}

/**
 * Write a generated wallet for the terminal: the seed words, the seed in
 * hex, then each network's addresses.
 *
 * @param wallet - The wallet to write.
 * @returns The report, as newline-joined lines.
 */
export function formatGeneratedWallet(wallet: GeneratedWallet): string {
  return [
    `Seed Words: ${wallet.mnemonic}`,
    `Seed Hex: ${wallet.seedHex}`,
    ...wallet.addresses.flatMap(({ networkId, addresses }) => [
      "",
      `Addresses on ${networkId}:`,
      `  Unshielded (NIGHT): ${addresses.unshielded}`,
      `  Shielded: ${addresses.shielded}`,
      `  Dust: ${addresses.dust}`,
    ]),
  ].join("\n");
}

/**
 * Read the networks named on a command line.
 *
 * @param names - The network ids as typed, e.g. `["preprod", "mainnet"]`.
 * @returns The named networks in the order given, or every network when none is named.
 * @throws {Error} If a name is not a network id.
 */
export function parseWalletNetworks(names: readonly string[]): readonly NetworkId[] {
  if (names.length === 0) return NETWORK_IDS;
  return names.map((name) => {
    const networkId = NETWORK_IDS.find((known) => known === name);
    if (networkId === undefined) {
      throw new Error(`Unknown network "${name}": expected one of ${NETWORK_IDS.join(", ")}.`);
    }
    return networkId;
  });
}
