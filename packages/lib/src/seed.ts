// Seed parsing — turns user input (a BIP-39 mnemonic or a raw hex seed) into
// the seed bytes the HD wallet derives from, plus a record of how it was
// supplied (so the normalised hex form can be used as a stable identifier).
import * as bip39 from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** How the input seed was supplied. (Const object + union — see network.ts.) */
export const SeedFormat = {
  Mnemonic: "mnemonic",
  Hex: "hex",
} as const;
export type SeedFormat = (typeof SeedFormat)[keyof typeof SeedFormat];

/** Where a parsed seed came from, including its normalised hex form. */
export interface DerivationSource {
  format: SeedFormat;
  /** Word count, when the input was a mnemonic. */
  words?: number;
  /** The normalised hex of the seed bytes — the stable dedup key. */
  seedHex: string;
  seedBytes: number;
}

export class ParseError extends Error {}

/**
 * Parse `input` as a hex seed (16–64 bytes, optional 0x prefix) or a BIP-39
 * mnemonic (run through PBKDF2 to its 64-byte seed). Throws {@link ParseError}
 * when it is neither.
 */
export function parseSeed(input: string): { seed: Uint8Array; source: DerivationSource } {
  const trimmed = input.trim();
  if (!trimmed) throw new ParseError("Nothing to parse — generate or paste a seed first.");

  const compact = trimmed.replace(/^0x/i, "");
  const looksHex = /^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0;

  if (looksHex) {
    const bytes = compact.length / 2;
    if (bytes < 16 || bytes > 64) {
      throw new ParseError(`Hex seed must be 16–64 bytes; got ${bytes}.`);
    }
    const seed = Uint8Array.from(compact.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
    return { seed, source: { format: SeedFormat.Hex, seedHex: compact.toLowerCase(), seedBytes: bytes } };
  }

  const words = trimmed.split(/\s+/);
  if (!bip39.validateMnemonic(words.join(" "), english)) {
    throw new ParseError("Not a valid BIP-39 mnemonic (and not valid hex).");
  }
  const seed = bip39.mnemonicToSeedSync(words.join(" "));
  return {
    seed,
    source: { format: SeedFormat.Mnemonic, words: words.length, seedHex: toHex(seed), seedBytes: seed.length },
  };
}

/** Generate a fresh random 24-word BIP-39 mnemonic (256 bits of entropy). */
export function generateMnemonic(): string {
  return bip39.generateMnemonic(english, 256);
}
