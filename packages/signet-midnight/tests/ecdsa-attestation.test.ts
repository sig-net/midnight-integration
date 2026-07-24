// ECDSA attestation helpers, the digest's TS twin, and the compiled verify
// circuit. The digest TS twin (`calculateSignetAttestationDigest`) is pinned
// byte-for-byte against the fixed-width oracle circuits circuits.compact
// exports, and the signing helper is checked against the COMPILED
// verification circuit (`pureCircuits.verifyRespondBidirectionalEvent32`) —
// the same check client contracts run in-circuit at claim time — so the
// off-chain signer and the on-chain verifier are pinned against each other
// in-process.

import { describe, expect, it } from "vitest";

import {
  bigintToBytes32,
  bytesToBigint,
  calculateSignetAttestationDigest,
  executionSucceeded,
  formatSecp256k1PublicKey,
  isExecutionError,
  MPC_ERROR_SENTINEL,
  parseSecp256k1PublicKey,
  SECP256K1_ORDER,
  secp256k1PublicKeyOf,
  signAttestationDigest,
  pureCircuits as signetCircuits,
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

// A 32-byte serialised output (one ABI word's worth) for the verify tests.
// The exact unpadded respond payload of a real request follows from its
// respond schema; the verify circuit never inspects the content.
const OUTPUT_32 = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

/**
 * Sign a REAL respond-bidirectional response for (requestId, output) with
 * `secretKey` — the digest comes from the TS twin, exactly like the MPC.
 * Signature scalars land as LE bytes, the ledger form.
 */
const respond = (
  secretKey: Uint8Array,
  requestId: Uint8Array,
  serializedOutput: Uint8Array = OUTPUT_32,
): RespondBidirectionalEvent => {
  const attestationDigest = calculateSignetAttestationDigest(
    requestId,
    serializedOutput,
  );
  const sig = signAttestationDigest(attestationDigest, secretKey);
  return {
    attestationDigest,
    r: bigintToBytes32(sig.r),
    s: bigintToBytes32(sig.s),
    recoveryId: BigInt(sig.recoveryId),
  };
};

describe("calculateSignetAttestationDigest (TS twin) x fixed-width oracle circuits", () => {
  // The BINDING tests: the TS twin must agree byte-for-byte with the
  // compiled generic circuit at every width. Per width: a patterned output,
  // an all-zero output, and a trailing-zero output (pinning that neither
  // side trims or pads the keccak preimage).
  const oracles = [
    { width: 1, oracle: signetCircuits.calculateSignetAttestationDigest1 },
    { width: 32, oracle: signetCircuits.calculateSignetAttestationDigest32 },
    { width: 100, oracle: signetCircuits.calculateSignetAttestationDigest100 },
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
      expect(calculateSignetAttestationDigest(REQUEST_ID, output)).toEqual(
        oracle(REQUEST_ID, output),
      );
    }
  });

  it("commits to both the request id and the output", () => {
    const digest = calculateSignetAttestationDigest(REQUEST_ID, OUTPUT_32);
    expect(digest).toHaveLength(32);
    expect(calculateSignetAttestationDigest(bytes(32, 0xab), OUTPUT_32)).not.toEqual(digest);
    expect(
      calculateSignetAttestationDigest(REQUEST_ID, bytes(32, 0x77)),
    ).not.toEqual(digest);
  });

  it("the exact width is part of the preimage: appending a zero byte changes the digest", () => {
    // There is no separate length binding: distinctness across widths comes
    // from the preimage bytes themselves (keccak's padding is length-aware).
    expect(calculateSignetAttestationDigest(REQUEST_ID, Uint8Array.from([1]))).not.toEqual(
      calculateSignetAttestationDigest(REQUEST_ID, Uint8Array.from([1, 0])),
    );
  });
});

describe("verifyRespondBidirectionalEvent32 (compiled circuit) x signAttestationDigest", () => {
  const valid = respond(MPC_SECRET, REQUEST_ID);

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
        s: bigintToBytes32(SECP256K1_ORDER - bytesToBigint(valid.s)),
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
      name: "fails when the digest checkpoint was tampered with (signature untouched)",
      event: { ...valid, attestationDigest: bytes(32, 0x99) },
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
    expect(
      signetCircuits.verifyRespondBidirectionalEvent32(requestId, serializedOutput, event, pk),
    ).toBe(expected);
  });

  it("the recovery id recovers the signing key from the digest", () => {
    const digest = calculateSignetAttestationDigest(REQUEST_ID, OUTPUT_32);
    const sig = signAttestationDigest(digest, MPC_SECRET);
    expect([0, 1]).toContain(sig.recoveryId);
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

// Outputs are the exact unpadded respond payloads: a packed bool is one
// byte, the error sentinel is its four bytes plus whatever the MPC appends.
const DECODE_CASES: DecodeCase[] = [
  {
    name: "a success flag (first byte 1)",
    serializedOutput: Uint8Array.from([1]),
    succeeded: true,
    error: false,
  },
  {
    name: "a false return (a zero byte)",
    serializedOutput: Uint8Array.from([0]),
    succeeded: false,
    error: false,
  },
  {
    name: "the MPC error sentinel (0xdeadbeef prefix)",
    serializedOutput: Uint8Array.from([...MPC_ERROR_SENTINEL, 0x01, 0x02]),
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
