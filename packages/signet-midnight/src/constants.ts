// MPC routing constants + the padded-ASCII codec for the signet request
// structs. Field widths mirror Signet.compact (the wire format —
// keep in lockstep); the string constants are the values the MPC network
// routes on. Ported from the MVP's contract-cli signet/constants.ts, adapted
// to the refactor's zero-padded convention (Compact `pad(N, "text")`) — the
// MVP's 2-byte length-prefixed codec is gone with the old layout.
//
// The routing constants belong in github.com/sig-net/signet.js — kept here
// until upstreamed.

/** Width of `SignBidirectionalEvent.caip2Id` (`Bytes<32>`). */
export const CAIP2_ID_BYTES = 32;

/** Width of `SignBidirectionalEvent.params` (`Bytes<64>`). */
export const MPC_PARAMS_BYTES = 64;

/** Width of `EVMCalldata.selector` (`Bytes<4>`) — the literal first 4 calldata bytes. */
export const SELECTOR_BYTES = 4;

/** Width of `RespondBidirectionalEvent.serializedOutput` (`Bytes<128>`). */
export const SERIALIZED_OUTPUT_BYTES = 128;

/**
 * The MPC's error sentinel: `serializedOutput` beginning with these four
 * bytes marks a failed/absent remote execution (mirrors the sig-net MPC's
 * MAGIC_ERROR_PREFIX).
 */
export const MPC_ERROR_SENTINEL = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

/**
 * Whether an attestation's serialized output reports a successful remote
 * execution: the first byte is 1 — the little-endian encoding of the
 * ABI-decoded success flag, matching the circuits'
 * `serializedOutput as Field == 1` check.
 *
 * @param serializedOutput - The attestation's serialized output.
 * @returns `true` when the remote call succeeded.
 */
export function executionSucceeded(serializedOutput: Uint8Array): boolean {
  return serializedOutput[0] === 1;
}

/**
 * Whether an attestation's serialized output is the MPC's error sentinel
 * (see {@link MPC_ERROR_SENTINEL}) rather than a call result.
 *
 * @param serializedOutput - The attestation's serialized output.
 * @returns `true` when the MPC reported an execution error.
 */
export function isExecutionError(serializedOutput: Uint8Array): boolean {
  return MPC_ERROR_SENTINEL.every((byte, index) => serializedOutput[index] === byte);
}

/**
 * Default MPC key version (`keyVersion` field value). Version 0 is the
 * unsupported legacy format — the canonical MPC (and
 * `constructSignBidirectionalEvent`) requires `keyVersion >= 1`.
 */
export const SIGNET_DEFAULT_KEY_VERSION = 1n;

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
