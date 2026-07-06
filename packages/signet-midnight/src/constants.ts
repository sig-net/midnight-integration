// MPC routing constants + the padded-ASCII codec for the signet request
// structs. Field widths mirror Signet.compact (the wire format —
// keep in lockstep); the string constants are the values the MPC network
// routes on. Ported from the MVP's contract-cli signet/constants.ts, adapted
// to the refactor's zero-padded convention (Compact `pad(N, "text")`) — the
// MVP's 2-byte length-prefixed codec is gone with the old layout.
//
// The routing constants belong in github.com/sig-net/signet.js — kept here
// until upstreamed.

/** Width of `SignetMPCRoutingParams.caip2Id` (`Bytes<64>`). */
export const CAIP2_ID_BYTES = 64;

/** Width of `SignetMPCRoutingParams.algo` (`Bytes<32>`). */
export const ALGO_BYTES = 32;

/** Width of `SignetMPCRoutingParams.dest` (`Bytes<64>`). */
export const DEST_BYTES = 64;

/** Width of `SignetMPCRoutingParams.params` (`Bytes<512>`). */
export const MPC_PARAMS_BYTES = 512;

/** Width of `SignetMPCRoutingParams.outputSchema` (`Bytes<256>`). */
export const OUTPUT_SCHEMA_BYTES = 256;

/** Width of `SignetMPCRoutingParams.respondSchema` (`Bytes<256>`). */
export const RESPOND_SCHEMA_BYTES = 256;

/** Signature algorithm the MPC uses for EVM chains (`algo` field value). */
export const SIGNET_ALGO_ECDSA = "ecdsa";

/** Destination chain family for EVM requests (`dest` field value). */
export const SIGNET_DEST_ETHEREUM = "ethereum";

/** Default MPC key version (`keyVersion` field value). */
export const SIGNET_DEFAULT_KEY_VERSION = 0n;

/**
 * Encode text as zero-padded ASCII bytes — the Compact `pad(N, "text")`
 * convention every string-ish field of the request structs uses (consumers
 * NUL-trim on decode).
 *
 * @param text - The ASCII text to encode.
 * @param length - The fixed field width in bytes.
 * @returns `text`'s bytes followed by zero padding to exactly `length`.
 * @throws If the encoded text does not fit in `length` bytes.
 */
export function asciiPadded(text: string, length: number): Uint8Array {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length > length) {
    throw new Error(`"${text}" is ${encoded.length} bytes — does not fit the ${length}-byte field`);
  }
  const out = new Uint8Array(length);
  out.set(encoded);
  return out;
}
