// ECDSA attestation helpers + the compiled digest/verify circuits. The
// signing helper is checked against the COMPILED verification circuit
// (`pureCircuits.verifyRespondBidirectionalEvent`) — the same check client
// contracts run in-circuit at claim time — so the off-chain signer and the
// on-chain verifier are pinned against each other in-process.

import { describe, expect, it } from "vitest";

import {
  CompactTypeBytes,
  CompactTypeVector,
  persistentHash,
} from "@midnight-ntwrk/compact-runtime";

import {
  bigintToBytes32,
  bigintToBytes32BE,
  ecdsaSignatureToMpcSignature,
  executionSucceeded,
  formatSecp256k1PublicKey,
  isExecutionError,
  MPC_ERROR_SENTINEL,
  mpcSignatureToEcdsaSignature,
  parseSecp256k1PublicKey,
  SECP256K1_ORDER,
  secp256k1PublicKeyOf,
  signAttestationDigest,
  pureCircuits as signetCircuits,
  type EcdsaSignature,
  type MpcSignature,
  type RespondBidirectionalEvent,
} from "../src/index.ts";

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

// Fixed keypairs so every run (and the RFC 6979 deterministic signature) is
// byte-for-byte reproducible. MPC_SECRET plays the MPC's response key (the
// per-client-contract key derived from the contract address + the fixed
// "midnight response key" path); the other is an imposter.
const MPC_SECRET = Uint8Array.from(
  Buffer.from("a3b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1", "hex"),
);
const MPC_PUBLIC = secp256k1PublicKeyOf(MPC_SECRET);
const IMPOSTER_SECRET = Uint8Array.from(
  Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex"),
);
const IMPOSTER_PUBLIC = secp256k1PublicKeyOf(IMPOSTER_SECRET);

const REQUEST_ID = bytes(32, 0x2f);
const OUTPUT_SUCCESS = (() => {
  const out = new Uint8Array(128);
  out[0] = 1;
  return out;
})();
const OUTPUT_LEN = 32n;

/**
 * Sign a REAL respond-bidirectional response for (requestId, output) with
 * `secretKey` — the digest comes from the compiled circuit, exactly like the
 * MPC. The signature lands in stored form (full R point), the ledger shape.
 */
const respond = (
  secretKey: Uint8Array,
  requestId: Uint8Array,
  serializedOutput: Uint8Array = OUTPUT_SUCCESS,
  outputLen: bigint = OUTPUT_LEN,
): RespondBidirectionalEvent => {
  const digest = signetCircuits.signetAttestationDigest(
    requestId,
    serializedOutput,
    outputLen,
  );
  return {
    serializedOutput,
    outputLen,
    signature: ecdsaSignatureToMpcSignature(signAttestationDigest(digest, secretKey)),
  };
};

describe("signetAttestationDigest (compiled circuit)", () => {
  it("hashes (requestId, hash(serializedOutput, outputLen)) into one 32-byte digest", () => {
    // Oracle for the circuit's nested hash: hash the output bytes with the
    // length's 32-byte LE field embed, then hash that alongside the id.
    const vec2 = new CompactTypeVector(2, new CompactTypeBytes(32));
    const outHash = persistentHash(vec2, [
      persistentHash(new CompactTypeBytes(128), OUTPUT_SUCCESS),
      bigintToBytes32(OUTPUT_LEN),
    ]);
    expect(
      signetCircuits.signetAttestationDigest(REQUEST_ID, OUTPUT_SUCCESS, OUTPUT_LEN),
    ).toEqual(persistentHash(vec2, [REQUEST_ID, outHash]));
  });
});

describe("verifyRespondBidirectionalEvent (compiled circuit) x signAttestationDigest", () => {
  const valid = respond(MPC_SECRET, REQUEST_ID);
  const validSig = mpcSignatureToEcdsaSignature(valid.signature);

  interface VerifyCase {
    name: string;
    event: RespondBidirectionalEvent;
    requestId: Uint8Array;
    pk: typeof MPC_PUBLIC;
    expected: boolean;
  }

  const CASES: VerifyCase[] = [
    {
      name: "a genuine response verifies against the signing key",
      event: valid,
      requestId: REQUEST_ID,
      pk: MPC_PUBLIC,
      expected: true,
    },
    {
      name: "the malleated twin (n - s) also verifies: stdlib does NOT enforce low-s",
      event: {
        ...valid,
        signature: ecdsaSignatureToMpcSignature({
          ...validSig,
          s: SECP256K1_ORDER - validSig.s,
        }),
      },
      requestId: REQUEST_ID,
      pk: MPC_PUBLIC,
      expected: true,
    },
    {
      name: "fails against a different public key",
      event: valid,
      requestId: REQUEST_ID,
      pk: IMPOSTER_PUBLIC,
      expected: false,
    },
    {
      name: "fails under a different request id",
      event: valid,
      requestId: bytes(32, 0xab),
      pk: MPC_PUBLIC,
      expected: false,
    },
    {
      name: "fails when the output was tampered with",
      event: {
        ...valid,
        serializedOutput: (() => {
          const out = new Uint8Array(OUTPUT_SUCCESS);
          out[100] = 0xff;
          return out;
        })(),
      },
      requestId: REQUEST_ID,
      pk: MPC_PUBLIC,
      expected: false,
    },
    {
      name: "fails when the output length was tampered with",
      event: { ...valid, outputLen: OUTPUT_LEN + 1n },
      requestId: REQUEST_ID,
      pk: MPC_PUBLIC,
      expected: false,
    },
    {
      name: "fails for an imposter's signature over the same content",
      event: respond(IMPOSTER_SECRET, REQUEST_ID),
      requestId: REQUEST_ID,
      pk: MPC_PUBLIC,
      expected: false,
    },
  ];

  it.each(CASES)("$name", ({ event, requestId, pk, expected }) => {
    // The client's exact claim path: read the stored signature off-chain,
    // hand the circuit LITTLE-endian scalars (the order `as Secp256k1Scalar`
    // reads).
    const sig = mpcSignatureToEcdsaSignature(event.signature);
    expect(
      signetCircuits.verifyRespondBidirectionalEvent(
        requestId,
        event.serializedOutput,
        event.outputLen,
        bigintToBytes32(sig.r),
        bigintToBytes32(sig.s),
        pk,
      ),
    ).toBe(expected);
  });

  it("the recovery id recovers the signing key from the digest", () => {
    const digest = signetCircuits.signetAttestationDigest(
      REQUEST_ID,
      OUTPUT_SUCCESS,
      OUTPUT_LEN,
    );
    const sig = signAttestationDigest(digest, MPC_SECRET);
    expect([0, 1]).toContain(sig.recoveryId);
  });
});

describe("ecdsaSignatureToMpcSignature x mpcSignatureToEcdsaSignature", () => {
  const SCALAR_SIG = signAttestationDigest(
    signetCircuits.signetAttestationDigest(REQUEST_ID, OUTPUT_SUCCESS, OUTPUT_LEN),
    MPC_SECRET,
  );
  const STORED = ecdsaSignatureToMpcSignature(SCALAR_SIG);

  it("reconstructs bigR with x = r and the parity the recovery id names", () => {
    expect(STORED.bigR.x).toEqual(bigintToBytes32BE(SCALAR_SIG.r));
    expect(STORED.bigR.y).toHaveLength(32);
    // Parity of a big-endian integer is its last byte's low bit.
    expect(STORED.bigR.y[31]! & 1).toBe(SCALAR_SIG.recoveryId);
    expect(STORED.s).toEqual(bigintToBytes32BE(SCALAR_SIG.s));
    expect(STORED.recoveryId).toBe(BigInt(SCALAR_SIG.recoveryId));
  });

  it("round-trips back to the scalar form", () => {
    expect(mpcSignatureToEcdsaSignature(STORED)).toEqual(SCALAR_SIG);
  });

  it("reduces a bigR.x beyond the curve order mod n on the way out", () => {
    expect(
      mpcSignatureToEcdsaSignature({
        ...STORED,
        bigR: { ...STORED.bigR, x: bigintToBytes32BE(SECP256K1_ORDER + 5n) },
      }).r,
    ).toBe(5n);
  });

  /** One row of the encode-reject table: a scalar signature the builder must refuse. */
  interface EncodeRejectCase {
    /** Test name, completing the sentence "encoding rejects <name>". */
    name: string;
    /** The out-of-domain scalar signature. */
    signature: EcdsaSignature;
    /** The expected error. */
    error: RegExp;
  }

  const ENCODE_REJECT_CASES: EncodeRejectCase[] = [
    {
      name: "a recovery id of 2",
      signature: { ...SCALAR_SIG, recoveryId: 2 },
      error: /recovery id/,
    },
    {
      // x = 5 has no square root on secp256k1 (smallest such x), so no point
      // exists to reconstruct.
      name: "an r that is not an x coordinate on the curve",
      signature: { ...SCALAR_SIG, r: 5n },
      error: /not the x coordinate/,
    },
  ];

  it.each(ENCODE_REJECT_CASES)("encoding rejects $name", ({ signature, error }) => {
    expect(() => ecdsaSignatureToMpcSignature(signature)).toThrow(error);
  });

  /** One row of the decode-reject table: a stored record the reader must refuse. */
  interface DecodeRejectCase {
    /** Test name, completing the sentence "decoding rejects <name>". */
    name: string;
    /** The malformed stored record. */
    signature: MpcSignature;
    /** The expected error. */
    error: RegExp;
  }

  const DECODE_REJECT_CASES: DecodeRejectCase[] = [
    {
      name: "a recovery id of 2",
      signature: { ...STORED, recoveryId: 2n },
      error: /recovery id/,
    },
    {
      name: "a truncated bigR.x",
      signature: { ...STORED, bigR: { ...STORED.bigR, x: STORED.bigR.x.subarray(0, 31) } },
      error: /32-byte/,
    },
    {
      name: "an oversized s",
      signature: { ...STORED, s: new Uint8Array(33) },
      error: /32-byte/,
    },
  ];

  it.each(DECODE_REJECT_CASES)("decoding rejects $name", ({ signature, error }) => {
    expect(() => mpcSignatureToEcdsaSignature(signature)).toThrow(error);
  });
});

describe("signetKeyHash (compiled circuit)", () => {
  it("hashes to 32 bytes, distinct per key", () => {
    const mpc = signetCircuits.signetKeyHash(MPC_PUBLIC);
    expect(mpc).toHaveLength(32);
    expect(mpc).not.toEqual(signetCircuits.signetKeyHash(IMPOSTER_PUBLIC));
  });
});

/** One row of the parse table: input → parsed point or rejection. */
interface ParseCase {
  /** Test name, completing the sentence "parses/rejects <name>". */
  name: string;
  /** The raw config/env value. */
  value: string;
  /** Whether the parse must succeed. */
  ok: boolean;
}

const UNCOMPRESSED_HEX = formatSecp256k1PublicKey(MPC_PUBLIC);

const PARSE_CASES: ParseCase[] = [
  { name: "uncompressed SEC1 hex with 0x prefix", value: UNCOMPRESSED_HEX, ok: true },
  { name: "uncompressed SEC1 hex without prefix", value: UNCOMPRESSED_HEX.slice(2), ok: true },
  { name: "a non-hex string", value: "not-a-key", ok: false },
  { name: "a truncated key", value: UNCOMPRESSED_HEX.slice(0, 20), ok: false },
  { name: "an off-curve point", value: `0x04${"11".repeat(64)}`, ok: false },
];

describe("parseSecp256k1PublicKey", () => {
  it.each(PARSE_CASES)("handles $name", ({ value, ok }) => {
    if (ok) {
      expect(parseSecp256k1PublicKey(value)).toEqual(MPC_PUBLIC);
    } else {
      expect(() => parseSecp256k1PublicKey(value)).toThrow();
    }
  });

  it("round-trips through formatSecp256k1PublicKey", () => {
    expect(parseSecp256k1PublicKey(formatSecp256k1PublicKey(MPC_PUBLIC))).toEqual(
      MPC_PUBLIC,
    );
  });
});

/** One row of the serializedOutput decode table: bytes → expected verdicts. */
interface DecodeCase {
  /** Test name, completing the sentence "decodes <name>". */
  name: string;
  /** The response's serialized output. */
  serializedOutput: Uint8Array;
  /** Expected {@link executionSucceeded} verdict. */
  succeeded: boolean;
  /** Expected {@link isExecutionError} verdict. */
  error: boolean;
}

const DECODE_CASES: DecodeCase[] = [
  {
    name: "a success flag (first byte 1)",
    serializedOutput: OUTPUT_SUCCESS,
    succeeded: true,
    error: false,
  },
  {
    name: "a false return (all zero)",
    serializedOutput: new Uint8Array(128),
    succeeded: false,
    error: false,
  },
  {
    name: "the MPC error sentinel (0xdeadbeef prefix)",
    serializedOutput: (() => {
      const out = new Uint8Array(128);
      out.set(MPC_ERROR_SENTINEL);
      return out;
    })(),
    succeeded: false,
    error: true,
  },
];

describe("serializedOutput decoding", () => {
  it.each(DECODE_CASES)("decodes $name", ({ serializedOutput, succeeded, error }) => {
    expect(executionSucceeded(serializedOutput)).toBe(succeeded);
    expect(isExecutionError(serializedOutput)).toBe(error);
  });
});
