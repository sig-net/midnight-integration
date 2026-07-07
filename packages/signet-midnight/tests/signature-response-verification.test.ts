// Verification of MPC signature responses against their request record: the
// unsigned EIP-1559 transaction is rebuilt exactly as the MPC assembles it,
// and the 65-byte r||s||v response must recover to the expected signer over
// its signing hash.

import { describe, expect, it } from "vitest";

import {
  computeAddress,
  getBytes,
  Interface,
  SigningKey,
  Transaction,
} from "ethers";

import {
  asciiPadded,
  bigintToBytes32,
  signetEVMSignatureRequestToSignedEVMTransaction,
  signetEVMSignatureRequestToUnsignedEVMTransaction,
  recoverSignetEVMSignatureResponseSigner,
  verifySignetEVMSignatureResponse,
  type SignetEVMSignatureRequest,
} from "../src/index.ts";

// ---- Fixtures ----

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

const ERC20 = bytes(20, 0xaa);
const VAULT_EVM = bytes(20, 0xee);
const AMOUNT = 1_000_000n;

// `Bytes<20> as Field as Bytes<32>`: little-endian embed — address bytes
// first, zero padding after (the convention the vault contract stores).
const VAULT_ADDRESS_WORD = new Uint8Array(32);
VAULT_ADDRESS_WORD.set(VAULT_EVM);

/**
 * Known-good request record for a `transfer(vault, amount)` deposit — the
 * base every test varies from. Shared across tests: NEVER mutate; build a
 * variation as an explicit spread with the delta inline.
 */
const REQUEST: SignetEVMSignatureRequest = {
  requestNonce: 0n,
  evmTransaction: {
    to: ERC20,
    chainId: 11155111n,
    nonce: 7n,
    gasLimit: 100_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    value: 0n,
  },
  calldata: {
    funcSig: asciiPadded("transfer(address,uint256)", 256),
    argCount: 2n,
    args: [
      VAULT_ADDRESS_WORD,
      bigintToBytes32(AMOUNT),
      new Uint8Array(32),
      new Uint8Array(32),
    ],
  },
  mpcRouting: {
    caip2Id: asciiPadded("eip155:11155111", 64),
    keyVersion: 0n,
    path: new Uint8Array(256),
    algo: asciiPadded("ecdsa", 32),
    dest: asciiPadded("ethereum", 64),
    params: new Uint8Array(512),
    outputSchema: new Uint8Array(256),
    respondSchema: new Uint8Array(256),
  },
};

// The "MPC" of these tests: a plain secp256k1 key standing in for the
// user's derived signer, plus a second key playing the imposter.
const MPC_KEY = new SigningKey(`0x${"11".repeat(32)}`);
const MPC_ADDRESS = computeAddress(MPC_KEY.publicKey);
const IMPOSTER_KEY = new SigningKey(`0x${"22".repeat(32)}`);

/** Sign `request`'s rebuilt tx hash with `key`, packed as 65-byte r||s||v. */
const signResponse = (
  key: SigningKey,
  request: SignetEVMSignatureRequest,
): Uint8Array => {
  const signature = key.sign(signetEVMSignatureRequestToUnsignedEVMTransaction(request).unsignedHash);
  const out = new Uint8Array(65);
  out.set(getBytes(signature.r), 0);
  out.set(getBytes(signature.s), 32);
  out[64] = signature.v; // 27/28
  return out;
};

const VALID_RESPONSE = signResponse(MPC_KEY, REQUEST);

// The same signature with v carried as a bare 0/1 recovery id instead of the
// legacy 27/28 — both forms appear in the wild and both must verify.
const VALID_RESPONSE_RECID = new Uint8Array(VALID_RESPONSE);
VALID_RESPONSE_RECID[64] = VALID_RESPONSE[64] - 27;

// ---- Tests ----

describe("signetEVMSignatureRequestToUnsignedEVMTransaction", () => {
  it("rebuilds the exact EIP-1559 transaction the request describes", () => {
    const tx = signetEVMSignatureRequestToUnsignedEVMTransaction(REQUEST);

    expect(tx.type).toBe(2);
    expect(tx.chainId).toBe(11155111n);
    expect(tx.nonce).toBe(7);
    expect(tx.gasLimit).toBe(100_000n);
    expect(tx.maxFeePerGas).toBe(30_000_000_000n);
    expect(tx.maxPriorityFeePerGas).toBe(1_000_000_000n);
    expect(tx.value).toBe(0n);
    expect(tx.to?.toLowerCase()).toBe(`0x${"aa".repeat(20)}`);

    // The calldata decodes back to the stored (LE-embedded) args.
    const iface = new Interface(["function transfer(address,uint256)"]);
    const [to, amount] = iface.decodeFunctionData("transfer", tx.data);
    expect((to as string).toLowerCase()).toBe(`0x${"ee".repeat(20)}`);
    expect(amount).toBe(AMOUNT);
  });

  it("rejects a record whose argCount disagrees with the function signature", () => {
    expect(() =>
      signetEVMSignatureRequestToUnsignedEVMTransaction({
        ...REQUEST,
        calldata: { ...REQUEST.calldata, argCount: 3n },
      }),
    ).toThrow(/argCount 3/);
  });
});

describe("recoverSignetEVMSignatureResponseSigner", () => {
  it("recovers the signing address from a genuine response", () => {
    expect(recoverSignetEVMSignatureResponseSigner(REQUEST, VALID_RESPONSE)).toBe(
      MPC_ADDRESS,
    );
  });

  it("rejects a response that is not 65 bytes", () => {
    expect(() =>
      recoverSignetEVMSignatureResponseSigner(REQUEST, bytes(64, 1)),
    ).toThrow(/65-byte/);
  });
});

/** One row of the verify table: request + response + claimed signer → verdict. */
interface VerifyCase {
  /** Test name, completing the sentence "verifies/rejects <name>". */
  name: string;
  /** The request record the response claims to answer. */
  request: SignetEVMSignatureRequest;
  /** The candidate 65-byte response. */
  response: Uint8Array;
  /** The signer the response must recover to. */
  expectedSigner: string;
  /** The expected verdict. */
  valid: boolean;
}

const VERIFY_CASES: VerifyCase[] = [
  {
    name: "a genuine response (v as 27/28)",
    request: REQUEST,
    response: VALID_RESPONSE,
    expectedSigner: MPC_ADDRESS,
    valid: true,
  },
  {
    name: "a genuine response (v as bare 0/1 recovery id)",
    request: REQUEST,
    response: VALID_RESPONSE_RECID,
    expectedSigner: MPC_ADDRESS,
    valid: true,
  },
  {
    name: "a genuine response against a lowercased expected address",
    request: REQUEST,
    response: VALID_RESPONSE,
    expectedSigner: MPC_ADDRESS.toLowerCase(),
    valid: true,
  },
  {
    name: "a response signed by another key",
    request: REQUEST,
    response: signResponse(IMPOSTER_KEY, REQUEST),
    expectedSigner: MPC_ADDRESS,
    valid: false,
  },
  {
    name: "a genuine signature over a DIFFERENT request (tampered amount)",
    request: {
      ...REQUEST,
      calldata: {
        ...REQUEST.calldata,
        args: [
          VAULT_ADDRESS_WORD,
          bigintToBytes32(AMOUNT + 1n),
          new Uint8Array(32),
          new Uint8Array(32),
        ],
      },
    },
    response: VALID_RESPONSE,
    expectedSigner: MPC_ADDRESS,
    valid: false,
  },
  {
    name: "garbage bytes",
    request: REQUEST,
    response: bytes(65, 0x5a),
    expectedSigner: MPC_ADDRESS,
    valid: false,
  },
  {
    name: "a wrong-width response",
    request: REQUEST,
    response: bytes(64, 1),
    expectedSigner: MPC_ADDRESS,
    valid: false,
  },
];

describe("verifySignetEVMSignatureResponse", () => {
  it.each(VERIFY_CASES)(
    "verdict on $name is $valid",
    ({ request, response, expectedSigner, valid }) => {
      expect(
        verifySignetEVMSignatureResponse(request, response, expectedSigner),
      ).toBe(valid);
    },
  );
});

describe("signetEVMSignatureRequestToSignedEVMTransaction", () => {
  it("attaches the response signature to the request's transaction", () => {
    const signed = signetEVMSignatureRequestToSignedEVMTransaction(
      REQUEST,
      VALID_RESPONSE,
    );

    expect(signed.isSigned()).toBe(true);
    // Signing is non-destructive: the signed tx carries the same body as the
    // unsigned one, so its signing hash is unchanged.
    expect(signed.unsignedHash).toBe(
      signetEVMSignatureRequestToUnsignedEVMTransaction(REQUEST).unsignedHash,
    );
    // The attached signature recovers to the MPC signer...
    expect(signed.from).toBe(MPC_ADDRESS);
    // ...and the serialized payload round-trips to the same signed tx, i.e.
    // it is broadcast-ready for eth_sendRawTransaction.
    const roundTripped = Transaction.from(signed.serialized);
    expect(roundTripped.from).toBe(MPC_ADDRESS);
    expect(roundTripped.hash).toBe(signed.hash);
  });

  it("normalizes a bare 0/1 recovery id in v", () => {
    const signed = signetEVMSignatureRequestToSignedEVMTransaction(
      REQUEST,
      VALID_RESPONSE_RECID,
    );
    expect(signed.from).toBe(MPC_ADDRESS);
  });

  it("rejects a response that is not 65 bytes", () => {
    expect(() =>
      signetEVMSignatureRequestToSignedEVMTransaction(REQUEST, bytes(64, 1)),
    ).toThrow(/65-byte/);
  });
});
