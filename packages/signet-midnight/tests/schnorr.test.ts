// Schnorr signing helpers + the compiled attestation-message circuit. The
// REAL verification round trip (schnorrSign → in-circuit schnorrVerify) is
// exercised by signet-contract's postRemoteExecutionResponse tests; here we
// pin the message construction against an independent oracle and the
// signing/parsing/decoding helpers' contracts.

import { describe, expect, it } from "vitest";

import { CompactTypeBytes, persistentHash } from "@midnight-ntwrk/compact-runtime";

import {
  deriveJubjubKeypair,
  formatJubjubPublicKey,
  hashJubjubPoint,
  isRemoteExecutionError,
  JUBJUB_ORDER,
  MPC_ERROR_SENTINEL,
  parseJubjubPublicKey,
  remoteExecutionSucceeded,
  schnorrSign,
  pureCircuits as signetCircuits,
} from "../src/index.ts";

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

const MPC_KEYS = deriveJubjubKeypair(bytes(32, 0x42));

/** Test oracle: 16 bytes little-endian as bigint (Compact `Bytes<16> as Field`). */
const leLimb16 = (data: Uint8Array, offset: number): bigint => {
  let result = 0n;
  for (let i = 15; i >= 0; i--) {
    result = (result << 8n) | BigInt(data[offset + i]);
  }
  return result;
};

describe("signetAttestationMessage (compiled circuit)", () => {
  it("encodes (requestId, hash(outputData)) as four 16-byte LE field limbs", () => {
    const requestId = bytes(32, 0x2f);
    const outputData = bytes(4096, 0x01);
    const outHash = persistentHash(new CompactTypeBytes(4096), outputData);

    expect(signetCircuits.signetAttestationMessage(requestId, outputData)).toEqual([
      leLimb16(requestId, 0),
      leLimb16(requestId, 16),
      leLimb16(outHash, 0),
      leLimb16(outHash, 16),
    ]);
  });
});

describe("schnorrSign", () => {
  const MSG = [1n, 2n, 3n, 4n];
  const challenge = (ax: bigint, ay: bigint, px: bigint, py: bigint, msg: bigint[]) =>
    signetCircuits.schnorrChallenge(ax, ay, px, py, msg);

  it("produces a response scalar inside the Jubjub order", () => {
    const signature = schnorrSign(MPC_KEYS.sk, MSG, challenge);
    expect(signature.response).toBeGreaterThan(0n);
    expect(signature.response).toBeLessThan(JUBJUB_ORDER);
  });

  it("is randomized: two signatures over the same message differ", () => {
    const first = schnorrSign(MPC_KEYS.sk, MSG, challenge);
    const second = schnorrSign(MPC_KEYS.sk, MSG, challenge);
    expect(second.announcement).not.toEqual(first.announcement);
  });

  it("rejects a secret key that reduces to zero", () => {
    expect(() => schnorrSign(JUBJUB_ORDER, MSG, challenge)).toThrow(
      /non-zero/,
    );
  });
});

describe("hashJubjubPoint", () => {
  it("hashes to 32 bytes, distinct per point", () => {
    const other = deriveJubjubKeypair(bytes(32, 0x43));
    expect(hashJubjubPoint(MPC_KEYS.pk)).toHaveLength(32);
    expect(hashJubjubPoint(MPC_KEYS.pk)).not.toEqual(hashJubjubPoint(other.pk));
  });
});

/** One row of the parse table: input → parsed point or rejection. */
interface ParseCase {
  /** Test name, completing the sentence "parses/rejects <name>". */
  name: string;
  /** The raw config/env value. */
  value: string;
  /** The expected point; absent = the parse must throw. */
  expected?: { x: bigint; y: bigint };
}

const PARSE_CASES: ParseCase[] = [
  { name: "decimal coordinates", value: "12,34", expected: { x: 12n, y: 34n } },
  { name: "0x-hex coordinates", value: "0xa,0xB", expected: { x: 10n, y: 11n } },
  { name: "surrounding whitespace", value: " 1 , 2 ", expected: { x: 1n, y: 2n } },
  { name: "a single coordinate", value: "12" },
  { name: "three coordinates", value: "1,2,3" },
  { name: "non-numeric coordinates", value: "foo,bar" },
  { name: "an empty coordinate", value: "1," },
];

describe("parseJubjubPublicKey", () => {
  it.each(PARSE_CASES)("handles $name", ({ value, expected }) => {
    if (expected === undefined) {
      expect(() => parseJubjubPublicKey(value)).toThrow();
    } else {
      expect(parseJubjubPublicKey(value)).toEqual(expected);
    }
  });
});

describe("formatJubjubPublicKey", () => {
  it("round-trips a real derived key through parseJubjubPublicKey", () => {
    expect(parseJubjubPublicKey(formatJubjubPublicKey(MPC_KEYS.pk))).toEqual(MPC_KEYS.pk);
  });

  it("formats as decimal \"x,y\"", () => {
    expect(formatJubjubPublicKey({ x: 12n, y: 34n })).toBe("12,34");
  });
});

/** One row of the outputData decode table: bytes → expected verdicts. */
interface DecodeCase {
  /** Test name, completing the sentence "decodes <name>". */
  name: string;
  /** The attestation output data (may be shorter than 4096 for brevity). */
  outputData: Uint8Array;
  /** Expected {@link remoteExecutionSucceeded} verdict. */
  succeeded: boolean;
  /** Expected {@link isRemoteExecutionError} verdict. */
  error: boolean;
}

const DECODE_CASES: DecodeCase[] = [
  {
    name: "a success flag (first byte 1)",
    outputData: (() => { const out = new Uint8Array(4096); out[0] = 1; return out; })(),
    succeeded: true,
    error: false,
  },
  {
    name: "a false return (all zero)",
    outputData: new Uint8Array(4096),
    succeeded: false,
    error: false,
  },
  {
    name: "the MPC error sentinel (0xdeadbeef prefix)",
    outputData: (() => {
      const out = new Uint8Array(4096);
      out.set(MPC_ERROR_SENTINEL);
      return out;
    })(),
    succeeded: false,
    error: true,
  },
];

describe("remote execution outputData decoding", () => {
  it.each(DECODE_CASES)("decodes $name", ({ outputData, succeeded, error }) => {
    expect(remoteExecutionSucceeded(outputData)).toBe(succeeded);
    expect(isRemoteExecutionError(outputData)).toBe(error);
  });
});
