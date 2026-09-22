// ECDSA attestation helpers, the digest's TS twin, and the compiled verify
// circuit. The digest TS twin (`calculateSignetAttestationDigest`) is pinned
// byte-for-byte against the fixed-width oracle circuits circuits.compact
// exports, and the signing helper is checked against the COMPILED
// verification circuit (`pureCircuits.verifyRespondBidirectionalEvent32`),
// the same check client contracts run in-circuit at claim time, so the
// off-chain signer and the on-chain verifier are pinned against each other
// in-process. The off-chain sifting check
// (`verifyRespondBidirectionalSignature`) runs the same table and must agree
// with the circuit on every row: a post it accepts is a post that proves.

import { encodeBase58, SigningKey } from "ethers";
import { describe, expect, it } from "vitest";

// Package-internal (deliberately absent from both entry points), tested via
// its defining module.
import { mpcSignatureToEcdsaSignature } from "../src/ecdsa-attestation.ts";
import {
  bigintToBytes32BE,
  bytesToBigintBE,
  formatSecp256k1PublicKey,
  type MpcSignature,
  normaliseSecp256k1PublicKey,
  parseSecp256k1PublicKey,
  pureCircuits as signetCircuits,
  type RespondBidirectionalEvent,
  respondBidirectionalEventToCircuitInput,
  SECP256K1_ORDER,
  verifyRespondBidirectionalSignature,
} from "../src/index.ts";
import {
  calculateSignetAttestationDigest,
  type EcdsaSignature,
  ecdsaSignatureToMpcSignature,
  secp256k1PublicKeyOf,
  signAttestationDigest,
} from "../src/testing.ts";

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

// Fixed keypairs so every run (and the RFC 6979 deterministic signature) is
// byte-for-byte reproducible. MPC_SECRET plays the MPC's response key (the
// per-client-contract key derived from the contract address + the fixed
// "midnight response key" path). The other is an imposter.
const MPC_SECRET = Uint8Array.from(
  Buffer.from("a3b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1", "hex"),
);
const MPC_PUBLIC = secp256k1PublicKeyOf(MPC_SECRET);
const IMPOSTER_SECRET = Uint8Array.from(
  Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex"),
);
const IMPOSTER_PUBLIC = secp256k1PublicKeyOf(IMPOSTER_SECRET);

const REQUEST_ID = bytes(32, 0x2f);

// A 32-byte serialised output (one ABI word's worth) for the verify tests.
// The exact unpadded respond payload of a real request follows from its
// respond schema. The verify circuit never inspects the content.
const OUTPUT_32 = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

/**
 * Sign a REAL respond-bidirectional response for (requestId, output) with
 * `secretKey`: the digest comes from the TS twin, exactly like the MPC.
 * The signature lands in stored form (full R point), the ledger shape.
 */
const HEIGHT = 9_401_212n;

const respond = (
  secretKey: Uint8Array,
  requestId: Uint8Array,
  serializedOutput: Uint8Array = OUTPUT_32,
  blockHeight: bigint = HEIGHT,
): RespondBidirectionalEvent => ({
  signature: ecdsaSignatureToMpcSignature(
    signAttestationDigest(
      calculateSignetAttestationDigest(requestId, blockHeight, serializedOutput),
      secretKey,
    ),
  ),
});

describe("calculateSignetAttestationDigest (TS twin) x fixed-width oracle circuits", () => {
  // The BINDING tests: the TS twin must agree byte-for-byte with the
  // compiled generic circuit at every width. Per width: a patterned output,
  // an all-zero output, and a trailing-zero output (pinning that both sides
  // align the preimage the same way).
  const oracles = [
    {
      width: 1,
      oracle: (id: Uint8Array, out: Uint8Array) =>
        signetCircuits.calculateSignetAttestationDigest1(id, HEIGHT, out),
    },
    {
      width: 2,
      oracle: (id: Uint8Array, out: Uint8Array) =>
        signetCircuits.calculateSignetAttestationDigest2(id, HEIGHT, out),
    },
    {
      width: 32,
      oracle: (id: Uint8Array, out: Uint8Array) =>
        signetCircuits.calculateSignetAttestationDigest32(id, HEIGHT, out),
    },
    {
      width: 100,
      oracle: (id: Uint8Array, out: Uint8Array) =>
        signetCircuits.calculateSignetAttestationDigest100(id, HEIGHT, out),
    },
  ] as const;

  const outputsOf = (width: number): Uint8Array[] => [
    Uint8Array.from({ length: width }, (_, i) => (i * 37 + 5) % 256),
    new Uint8Array(width),
    (() => {
      const out = new Uint8Array(width);
      out[0] = 1;
      return out;
    })(),
  ];

  it.each(oracles)("matches the compiled Bytes<$width> oracle", ({ width, oracle }) => {
    for (const output of outputsOf(width)) {
      expect(calculateSignetAttestationDigest(REQUEST_ID, HEIGHT, output)).toEqual(
        oracle(REQUEST_ID, output),
      );
    }
  });

  it("commits to the request id, the block height and the output", () => {
    const digest = calculateSignetAttestationDigest(REQUEST_ID, HEIGHT, OUTPUT_32);
    expect(digest).toHaveLength(32);
    expect(calculateSignetAttestationDigest(REQUEST_ID, HEIGHT + 1n, OUTPUT_32)).not.toEqual(
      digest,
    );
    expect(calculateSignetAttestationDigest(bytes(32, 0xab), HEIGHT, OUTPUT_32)).not.toEqual(
      digest,
    );
    expect(calculateSignetAttestationDigest(REQUEST_ID, HEIGHT, bytes(32, 0x77))).not.toEqual(
      digest,
    );
  });

  it("changes with the output's content", () => {
    expect(calculateSignetAttestationDigest(REQUEST_ID, HEIGHT, Uint8Array.from([1]))).not.toEqual(
      calculateSignetAttestationDigest(REQUEST_ID, HEIGHT, Uint8Array.from([1, 2])),
    );
  });

  it("the output width is part of the digest", () => {
    const oneByte = calculateSignetAttestationDigest(REQUEST_ID, HEIGHT, Uint8Array.from([1]));
    const zeroPaddedTo31 = new Uint8Array(31);
    zeroPaddedTo31[0] = 1;
    expect(
      calculateSignetAttestationDigest(REQUEST_ID, HEIGHT, Uint8Array.from([1, 0])),
    ).not.toEqual(oneByte);
    expect(calculateSignetAttestationDigest(REQUEST_ID, HEIGHT, zeroPaddedTo31)).not.toEqual(
      oneByte,
    );
  });

  it("the compiled circuit binds the width too", () => {
    expect(
      signetCircuits.calculateSignetAttestationDigest2(REQUEST_ID, HEIGHT, Uint8Array.from([1, 0])),
    ).not.toEqual(
      signetCircuits.calculateSignetAttestationDigest1(REQUEST_ID, HEIGHT, Uint8Array.from([1])),
    );
  });

  it("crossing a 31-byte chunk boundary changes the digest", () => {
    const within = new Uint8Array(31);
    within[0] = 1;
    const across = new Uint8Array(62);
    across[0] = 1;
    expect(calculateSignetAttestationDigest(REQUEST_ID, HEIGHT, across)).not.toEqual(
      calculateSignetAttestationDigest(REQUEST_ID, HEIGHT, within),
    );
  });

  it("leaves byte 31 zero: the field element occupies the low 31 bytes", () => {
    const digest = calculateSignetAttestationDigest(REQUEST_ID, HEIGHT, OUTPUT_32);
    expect(digest.at(31)).toBe(0);
  });
});

describe("verifyRespondBidirectionalEvent32 (compiled circuit) x signAttestationDigest", () => {
  const valid = respond(MPC_SECRET, REQUEST_ID);
  const validSig = mpcSignatureToEcdsaSignature(valid.signature);

  interface VerifyCase {
    name: string;
    event: RespondBidirectionalEvent;
    serializedOutput: Uint8Array;
    requestId: Uint8Array;
    pk: typeof MPC_PUBLIC;
    expected: boolean;
  }

  const CASES: VerifyCase[] = [
    {
      name: "a genuine response verifies against the signing key",
      event: valid,
      serializedOutput: OUTPUT_32,
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
      serializedOutput: OUTPUT_32,
      requestId: REQUEST_ID,
      pk: MPC_PUBLIC,
      expected: true,
    },
    {
      name: "fails against a different public key",
      event: valid,
      serializedOutput: OUTPUT_32,
      requestId: REQUEST_ID,
      pk: IMPOSTER_PUBLIC,
      expected: false,
    },
    {
      name: "fails under a different request id",
      event: valid,
      serializedOutput: OUTPUT_32,
      requestId: bytes(32, 0xab),
      pk: MPC_PUBLIC,
      expected: false,
    },
    {
      name: "fails under a different block height",
      event: respond(MPC_SECRET, REQUEST_ID, OUTPUT_32, HEIGHT + 1n),
      serializedOutput: OUTPUT_32,
      requestId: REQUEST_ID,
      pk: MPC_PUBLIC,
      expected: false,
    },
    {
      name: "fails when the presented output differs from what was signed",
      event: valid,
      serializedOutput: (() => {
        const out = new Uint8Array(OUTPUT_32);
        out[7] = 0xff;
        return out;
      })(),
      requestId: REQUEST_ID,
      pk: MPC_PUBLIC,
      expected: false,
    },
    {
      name: "fails when the stored signature scalar s was tampered with",
      event: {
        signature: ecdsaSignatureToMpcSignature({
          ...validSig,
          s: validSig.s + 1n,
        }),
      },
      serializedOutput: OUTPUT_32,
      requestId: REQUEST_ID,
      pk: MPC_PUBLIC,
      expected: false,
    },
    {
      name: "fails for an imposter's signature over the same content",
      event: respond(IMPOSTER_SECRET, REQUEST_ID),
      serializedOutput: OUTPUT_32,
      requestId: REQUEST_ID,
      pk: MPC_PUBLIC,
      expected: false,
    },
  ];

  it.each(CASES)("$name", ({ event, serializedOutput, requestId, pk, expected }) => {
    // The client's exact claim path: the record as read, flipped to the
    // circuit-input form at the circuit call.
    expect(
      signetCircuits.verifyRespondBidirectionalEvent32(
        requestId,
        HEIGHT,
        serializedOutput,
        respondBidirectionalEventToCircuitInput(event),
        pk,
      ),
    ).toBe(expected);
  });

  it("a wire-order (unflipped) record does not verify in-circuit", () => {
    // Pins the circuit-input convention itself: the circuit reads the
    // signature scalars little-endian, so the big-endian wire record must be
    // passed through respondBidirectionalEventToCircuitInput first.
    expect(
      signetCircuits.verifyRespondBidirectionalEvent32(
        REQUEST_ID,
        HEIGHT,
        OUTPUT_32,
        valid,
        MPC_PUBLIC,
      ),
    ).toBe(false);
  });

  it("the circuit-input flip touches only bigR.x and s", () => {
    const flipped = respondBidirectionalEventToCircuitInput(valid);
    expect(flipped.signature.bigR.x).toEqual(Uint8Array.from(valid.signature.bigR.x).reverse());
    expect(flipped.signature.s).toEqual(Uint8Array.from(valid.signature.s).reverse());
    expect(flipped.signature.bigR.y).toEqual(valid.signature.bigR.y);
    expect(flipped.signature.recoveryId).toBe(valid.signature.recoveryId);
  });

  // The off-chain sifting check must answer exactly what the circuit answers:
  // it is what picks one post out of the unauthenticated log, and a
  // disagreement either drops a provable post or forwards an unprovable one.
  it.each(CASES)(
    "$name (off chain, verifyRespondBidirectionalSignature)",
    ({ event, serializedOutput, requestId, pk, expected }) => {
      expect(
        verifyRespondBidirectionalSignature(requestId, HEIGHT, serializedOutput, event, pk),
      ).toBe(expected);
    },
  );

  it("returns false for a malformed stored signature rather than throwing", () => {
    expect(
      verifyRespondBidirectionalSignature(
        REQUEST_ID,
        HEIGHT,
        OUTPUT_32,
        { signature: { ...valid.signature, recoveryId: 2n } },
        MPC_PUBLIC,
      ),
    ).toBe(false);
  });

  it("the recovery id recovers the signing key from the digest", () => {
    const digest = calculateSignetAttestationDigest(REQUEST_ID, HEIGHT, OUTPUT_32);
    const sig = signAttestationDigest(digest, MPC_SECRET);
    expect([0, 1]).toContain(sig.recoveryId);
  });
});

describe("ecdsaSignatureToMpcSignature x mpcSignatureToEcdsaSignature", () => {
  const SCALAR_SIG = signAttestationDigest(
    calculateSignetAttestationDigest(REQUEST_ID, HEIGHT, OUTPUT_32),
    MPC_SECRET,
  );
  const STORED = ecdsaSignatureToMpcSignature(SCALAR_SIG);

  it("reconstructs bigR with x = r and the parity the recovery id names", () => {
    expect(STORED.bigR.x).toEqual(bigintToBytes32BE(SCALAR_SIG.r));
    expect(STORED.bigR.y).toHaveLength(32);
    // Parity of a big-endian integer is its low bit.
    expect(bytesToBigintBE(STORED.bigR.y) & 1n).toBe(BigInt(SCALAR_SIG.recoveryId));
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

/** One row of the parse table: input → parsed point or rejection. */
interface ParseCase {
  /** Test name, completing the sentence "parses/rejects <name>". */
  name: string;
  /** The raw config/env value. */
  value: string;
}

const UNCOMPRESSED_HEX = formatSecp256k1PublicKey(MPC_PUBLIC);
const COMPRESSED_HEX = SigningKey.computePublicKey(UNCOMPRESSED_HEX, true);
// NEAR's spelling: `secp256k1:` + base58 of the raw X||Y point (no 04 byte).
const NEAR_FORM = `secp256k1:${encodeBase58(
  Uint8Array.from([...bigintToBytes32BE(MPC_PUBLIC.x), ...bigintToBytes32BE(MPC_PUBLIC.y)]),
)}`;

const PARSE_OK_CASES: ParseCase[] = [
  { name: "uncompressed SEC1 hex with 0x prefix", value: UNCOMPRESSED_HEX },
  { name: "uncompressed SEC1 hex without prefix", value: UNCOMPRESSED_HEX.slice(2) },
  { name: "compressed SEC1 hex with 0x prefix", value: COMPRESSED_HEX },
  { name: "compressed SEC1 hex without prefix", value: COMPRESSED_HEX.slice(2) },
  { name: "NEAR secp256k1:<base58>", value: NEAR_FORM },
  { name: "surrounding whitespace", value: `  ${NEAR_FORM}\n` },
];

const PARSE_REJECT_CASES: ParseCase[] = [
  { name: "a blank value", value: "   " },
  { name: "a non-hex string", value: "not-a-key" },
  { name: "a truncated key", value: UNCOMPRESSED_HEX.slice(0, 20) },
  { name: "an off-curve point", value: `0x04${"11".repeat(64)}` },
  { name: "NEAR text that is not base58", value: "secp256k1:0OIl" },
  { name: "a NEAR key decoding wider than 64 bytes", value: `secp256k1:${"z".repeat(100)}` },
  { name: "an unknown prefix", value: `ed25519:${NEAR_FORM.slice(10)}` },
];

describe("parseSecp256k1PublicKey", () => {
  it.each(PARSE_OK_CASES)("parses $name", ({ value }) => {
    expect(parseSecp256k1PublicKey(value)).toEqual(MPC_PUBLIC);
  });

  it.each(PARSE_REJECT_CASES)("rejects $name", ({ value }) => {
    expect(() => parseSecp256k1PublicKey(value)).toThrow();
  });

  it("round-trips through formatSecp256k1PublicKey", () => {
    expect(parseSecp256k1PublicKey(formatSecp256k1PublicKey(MPC_PUBLIC))).toEqual(MPC_PUBLIC);
  });
});

// The stagenet MPC root key as the MPC operators hand it out (NEAR form) and
// its canonical spelling: a fixed vector, computed independently of the
// parser, so the canonicaliser cannot drift with it.
const STAGENET_NEAR_FORM =
  "secp256k1:3Ww8iFjqTHufye5aRGUvrQqETegR4gVUcW8FX5xzscaN9ENhpkffojsxJwi6N1RbbHMTxYa9UyKeqK3fsMuwxjR5";
const STAGENET_CANONICAL =
  "0x047dd8ecafa5d9c921485b6ac33476870e98c3378e395f3c8fae92ce4943d8432847f591ab25ca454effb522ec2eaf04b7e1c83ba65ae731ea98dd52eb7d458dd4";
const STAGENET_COMPRESSED = "0x027dd8ecafa5d9c921485b6ac33476870e98c3378e395f3c8fae92ce4943d84328";

describe("normaliseSecp256k1PublicKey", () => {
  it.each([
    { name: "NEAR secp256k1:<base58>", value: STAGENET_NEAR_FORM },
    { name: "the canonical spelling itself", value: STAGENET_CANONICAL },
    { name: "uncompressed SEC1 hex without prefix", value: STAGENET_CANONICAL.slice(2) },
    { name: "compressed SEC1 hex", value: STAGENET_COMPRESSED },
    { name: "uppercase hex", value: `0x${STAGENET_CANONICAL.slice(2).toUpperCase()}` },
  ] satisfies ParseCase[])("canonicalises $name", ({ value }) => {
    expect(normaliseSecp256k1PublicKey(value)).toBe(STAGENET_CANONICAL);
  });

  it.each(PARSE_REJECT_CASES)("rejects $name", ({ value }) => {
    expect(() => normaliseSecp256k1PublicKey(value)).toThrow();
  });
});
