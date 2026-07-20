// secp256k1 ECDSA signing helpers + the compiled attestation-message circuit.
// The REAL verification round trip (signAttestation → in-circuit
// secp256k1EcdsaVerify) is exercised by signet-contract's
// postRespondBidirectional tests; here we pin the digest construction against
// an independent oracle and the signing/parsing/encoding helpers' contracts.

import { describe, expect, it } from "vitest";

import { secp256k1 } from "@noble/curves/secp256k1.js";

import {
  CompactTypeBytes,
  CompactTypeVector,
  persistentHash,
} from "@midnight-ntwrk/compact-runtime";

import {
  asciiPadded,
  bytesToBigint,
  ecdsaSignatureToLeBytes,
  formatSecp256k1PublicKey,
  hashSecp256k1Point,
  parseSecp256k1PublicKey,
  secp256k1PublicKeyFromSecretKey,
  SECP256K1_ORDER,
  signAttestation,
  pureCircuits as signetCircuits,
} from "../src/index.ts";

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

/** A fixed, valid secp256k1 secret key (< n, non-zero) — the "MPC root key". */
const MPC_SECRET_KEY = bytes(32, 0x42);
const MPC_PK = secp256k1PublicKeyFromSecretKey(MPC_SECRET_KEY);

/** Encode a Compact `Uint<8> as Field as Bytes<32>` value: 32 little-endian bytes. */
function leField(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

describe("signetAttestationMessage (compiled circuit)", () => {
  it("is the domain-tagged hash of (requestId, hash(serializedOutput, outputLen))", () => {
    const requestId = bytes(32, 0x2f);
    const serializedOutput = bytes(128, 0x01);
    const outputLen = 32n;
    // Oracle: hash the output bytes bound with the length, then hash that under
    // the domain tag alongside the request id — a plain re-derivation with the
    // runtime primitives, not a re-port of the circuit's logic.
    const outHash = persistentHash(
      new CompactTypeVector(2, new CompactTypeBytes(32)),
      [
        persistentHash(new CompactTypeBytes(128), serializedOutput),
        leField(outputLen),
      ],
    );
    const digest = persistentHash(
      new CompactTypeVector(3, new CompactTypeBytes(32)),
      [asciiPadded("signet:midnight:attest", 32), requestId, outHash],
    );

    expect(
      signetCircuits.signetAttestationMessage(requestId, serializedOutput, outputLen),
    ).toEqual(digest);
  });

  it("changes when the request id changes", () => {
    const serializedOutput = bytes(128, 0x01);
    const a = signetCircuits.signetAttestationMessage(bytes(32, 0x2f), serializedOutput, 32n);
    const b = signetCircuits.signetAttestationMessage(bytes(32, 0x30), serializedOutput, 32n);
    expect(a).not.toEqual(b);
  });
});

describe("signAttestation", () => {
  const digest = bytes(32, 0x7c);

  it("produces a signature that noble's own verifier accepts against the MPC key", () => {
    const sig = signAttestation(digest, MPC_SECRET_KEY);
    const compact = new secp256k1.Signature(sig.r, sig.s).toBytes("compact");
    expect(
      secp256k1.verify(compact, digest, secp256k1.getPublicKey(MPC_SECRET_KEY, true), {
        prehash: false,
      }),
    ).toBe(true);
  });

  it("is low-s normalized (s <= n/2) and deterministic (RFC 6979)", () => {
    const sig = signAttestation(digest, MPC_SECRET_KEY);
    expect(sig.s).toBeLessThanOrEqual(SECP256K1_ORDER / 2n);
    expect(signAttestation(digest, MPC_SECRET_KEY)).toEqual(sig);
  });

  it("binds the digest: a different digest yields a different signature", () => {
    expect(signAttestation(bytes(32, 0x01), MPC_SECRET_KEY)).not.toEqual(
      signAttestation(bytes(32, 0x02), MPC_SECRET_KEY),
    );
  });
});

describe("ecdsaSignatureToLeBytes", () => {
  it("round-trips the scalars through little-endian bytes", () => {
    const sig = signAttestation(bytes(32, 0x7c), MPC_SECRET_KEY);
    const { sigR, sigS } = ecdsaSignatureToLeBytes(sig);
    expect(sigR).toHaveLength(32);
    expect(sigS).toHaveLength(32);
    expect(bytesToBigint(sigR)).toBe(sig.r);
    expect(bytesToBigint(sigS)).toBe(sig.s);
  });
});

describe("secp256k1PublicKeyFromSecretKey", () => {
  it("matches noble's uncompressed public key coordinates", () => {
    const uncompressed = secp256k1.getPublicKey(MPC_SECRET_KEY, false);
    const point = secp256k1.Point.fromBytes(uncompressed);
    expect(MPC_PK).toEqual({ x: point.x, y: point.y, identity: false });
  });
});

describe("hashSecp256k1Point", () => {
  it("hashes to 32 bytes, distinct per point", () => {
    const other = secp256k1PublicKeyFromSecretKey(bytes(32, 0x43));
    expect(hashSecp256k1Point(MPC_PK)).toHaveLength(32);
    expect(hashSecp256k1Point(MPC_PK)).not.toEqual(hashSecp256k1Point(other));
  });
});

/** One row of the parse table: input → parsed point or rejection. */
interface ParseCase {
  /** Test name, completing the sentence "parses/rejects <name>". */
  name: string;
  /** The raw config/env value. */
  value: string;
  /** Whether the parse must succeed (compared against the MPC key) or throw. */
  valid: boolean;
}

const PARSE_CASES: ParseCase[] = [
  { name: "compressed 0x-hex", value: formatSecp256k1PublicKey(MPC_PK), valid: true },
  { name: "compressed hex without 0x", value: formatSecp256k1PublicKey(MPC_PK).slice(2), valid: true },
  { name: "an empty string", value: "", valid: false },
  { name: "non-hex text", value: "not-a-key", valid: false },
  { name: "an off-curve point", value: `0x02${"00".repeat(32)}`, valid: false },
];

describe("parseSecp256k1PublicKey", () => {
  it.each(PARSE_CASES)("handles $name", ({ value, valid }) => {
    if (!valid) {
      expect(() => parseSecp256k1PublicKey(value)).toThrow();
    } else {
      expect(parseSecp256k1PublicKey(value)).toEqual(MPC_PK);
    }
  });

  it("accepts an uncompressed encoding too", () => {
    const uncompressed = `0x${Buffer.from(secp256k1.getPublicKey(MPC_SECRET_KEY, false)).toString("hex")}`;
    expect(parseSecp256k1PublicKey(uncompressed)).toEqual(MPC_PK);
  });
});

describe("formatSecp256k1PublicKey", () => {
  it("round-trips the MPC key through parseSecp256k1PublicKey", () => {
    expect(parseSecp256k1PublicKey(formatSecp256k1PublicKey(MPC_PK))).toEqual(MPC_PK);
  });

  it("emits compressed 0x-hex (33 bytes, 02/03 prefix)", () => {
    const hex = formatSecp256k1PublicKey(MPC_PK);
    expect(hex).toMatch(/^0x0[23][0-9a-f]{64}$/);
  });

  it("rejects the identity point", () => {
    expect(() => formatSecp256k1PublicKey({ x: 0n, y: 0n, identity: true })).toThrow();
  });
});
