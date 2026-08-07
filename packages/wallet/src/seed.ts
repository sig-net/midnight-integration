// Seed parsing — turns user input (a BIP-39 mnemonic or a raw hex seed) into
// the seed bytes the HD wallet derives from, plus a record of how it was
// supplied (so the normalised hex form can be used as a stable identifier).
import { randomBytes } from "node:crypto";

import * as bip39 from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { hexToBytes } from "@sig-net/midnight";

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** How the input seed was supplied. (Const object + union — see network.ts.) */
export const SeedFormat = {
  Mnemonic: "mnemonic",
  Hex: "hex",
} as const;
/** The form a seed was supplied in. */
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

/** Thrown when an input is neither a valid hex seed nor a BIP-39 mnemonic. */
export class ParseError extends Error {}

/**
 * Parse `input` as a hex seed (16–64 bytes, optional 0x prefix) or a BIP-39
 * mnemonic (run through PBKDF2 to its 64-byte seed). Throws {@link ParseError}
 * when it is neither.
 *
 * @param input - The hex seed or mnemonic to parse.
 * @returns The seed bytes and a record of how they were supplied.
 * @throws {ParseError} If the input is neither form, or a hex seed is outside
 *   16 to 64 bytes.
 */
export function parseSeed(input: string): { seed: Uint8Array; source: DerivationSource } {
  const trimmed = input.trim();
  if (!trimmed) throw new ParseError("Nothing to parse — generate or paste a seed first.");

  const compact = trimmed.replace(/^0x/i, "");
  const looksHex = /^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0;

  if (looksHex) {
    const bytes = compact.length / 2;
    if (bytes < 16 || bytes > 64) {
      throw new ParseError(`Hex seed must be 16–64 bytes; got ${String(bytes)}.`);
    }
    const seed = hexToBytes(compact);
    return {
      seed,
      source: { format: SeedFormat.Hex, seedHex: compact.toLowerCase(), seedBytes: bytes },
    };
  }

  const words = trimmed.split(/\s+/);
  if (!bip39.validateMnemonic(words.join(" "), english)) {
    throw new ParseError("Not a valid BIP-39 mnemonic (and not valid hex).");
  }
  const seed = bip39.mnemonicToSeedSync(words.join(" "));
  return {
    seed,
    source: {
      format: SeedFormat.Mnemonic,
      words: words.length,
      seedHex: toHex(seed),
      seedBytes: seed.length,
    },
  };
}

/**
 * Generate a fresh random 24-word BIP-39 mnemonic (256 bits of entropy).
 *
 * @returns The generated mnemonic.
 */
export function generateMnemonic(): string {
  return bip39.generateMnemonic(english, 256);
}

/**
 * Generate a fresh random 32-byte seed as lowercase hex (no `0x` prefix).
 * Preferred over a mnemonic for generated role wallets: it parses through
 * {@link parseSeed} AND is the shape non-JS consumers expect (e.g. the
 * fakenet responder container reads its wallet seed as raw hex).
 *
 * @returns 64 hex chars (32 bytes) of cryptographically-random seed.
 */
export function generateHexSeed(): string {
  return toHex(randomBytes(32));
}

/**
 * Resolve a 32-byte identity secret key from the environment: `env[envVar]`
 * (hex, optional 0x prefix) when set, else the bytes of `fallbackSeed` (the
 * wallet seed doubling as the identity). Contract packages use this for the
 * secret whose commitment gates a circuit (e.g. a deployer identity),
 * and clients use it for the caller identity answering a secret-key witness.
 *
 * @param envVar - Name of the environment variable holding the hex secret.
 * @param env - The environment to read from.
 * @param fallbackSeed - The wallet seed (hex or mnemonic) used as the identity when `env[envVar]` is unset.
 * @returns The 32-byte secret key.
 * @throws {ParseError} If `env[envVar]` is set but not 32 bytes of hex, or if it is unset
 * and `fallbackSeed` does not parse to exactly 32 bytes (e.g. a mnemonic).
 */
export function parseIdentitySecretKey(
  envVar: string,
  env: Record<string, string | undefined>,
  fallbackSeed: string,
): Uint8Array {
  const raw = env[envVar]?.trim();
  if (raw) {
    const hex = raw.replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new ParseError(`${envVar} must be exactly 32 bytes of hex`);
    }
    return hexToBytes(hex);
  }
  const { seed } = parseSeed(fallbackSeed);
  if (seed.length !== 32) {
    throw new ParseError(
      `The fallback seed parses to ${String(seed.length)} bytes; the identity secret needs exactly 32. ` +
        `Set ${envVar} explicitly.`,
    );
  }
  return seed;
}
