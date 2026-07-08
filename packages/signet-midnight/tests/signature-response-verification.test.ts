// Verification of MPC signature responses against their request record: the
// unsigned EIP-1559 transaction is rebuilt exactly as the MPC assembles it,
// and the posted { bigR, s, recoveryId } record must recover to the expected
// signer over its signing hash.

import { describe, expect, it } from "vitest";

import {
  computeAddress,
  Interface,
  Signature,
  SigningKey,
  Transaction,
} from "ethers";

import {
  asciiPadded,
  bigintToBytes32,
  signatureToSignetEVMSignatureResponse,
  signetEVMSignatureRequestToSignedEVMTransaction,
  signetEVMSignatureRequestToUnsignedEVMTransaction,
  recoverSignetEVMSignatureResponseSigner,
  verifySignetEVMSignatureResponse,
  type SignetEVMSignatureRequest,
  type SignetEVMSignatureResponse,
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
    funcSig: asciiPadded("transfer(address,uint256)", 64),
    argCount: 2n,
    args: [VAULT_ADDRESS_WORD, bigintToBytes32(AMOUNT)],
  },
  mpcRouting: {
    caip2Id: asciiPadded("eip155:11155111", 32),
    keyVersion: 1n,
    path: new Uint8Array(256),
    algo: asciiPadded("ecdsa", 32),
    dest: asciiPadded("ethereum", 32),
    params: new Uint8Array(64),
    outputDeserializationSchema: new Uint8Array(128),
    respondSerializationSchema: new Uint8Array(128),
  },
};

// The "MPC" of these tests: a plain secp256k1 key standing in for the
// user's derived signer, plus a second key playing the imposter.
const MPC_KEY = new SigningKey(`0x${"11".repeat(32)}`);
const MPC_ADDRESS = computeAddress(MPC_KEY.publicKey);
const IMPOSTER_KEY = new SigningKey(`0x${"22".repeat(32)}`);

/** Sign `request`'s rebuilt tx hash with `key`, packed as a response record. */
const signResponse = (
  key: SigningKey,
  request: SignetEVMSignatureRequest,
): SignetEVMSignatureResponse =>
  signatureToSignetEVMSignatureResponse(
    key.sign(
      signetEVMSignatureRequestToUnsignedEVMTransaction(request).unsignedHash,
    ),
  );

const VALID_RESPONSE = signResponse(MPC_KEY, REQUEST);

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

  it("rejects a response with an out-of-range recovery id", () => {
    expect(() =>
      recoverSignetEVMSignatureResponseSigner(REQUEST, {
        ...VALID_RESPONSE,
        recoveryId: 5n,
      }),
    ).toThrow(/recovery id/);
  });
});

/** One row of the verify table: request + response + claimed signer → verdict. */
interface VerifyCase {
  /** Test name, completing the sentence "verifies/rejects <name>". */
  name: string;
  /** The request record the response claims to answer. */
  request: SignetEVMSignatureRequest;
  /** The candidate response record. */
  response: SignetEVMSignatureResponse;
  /** The signer the response must recover to. */
  expectedSigner: string;
  /** The expected verdict. */
  valid: boolean;
}

const VERIFY_CASES: VerifyCase[] = [
  {
    name: "a genuine response",
    request: REQUEST,
    response: VALID_RESPONSE,
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
        args: [VAULT_ADDRESS_WORD, bigintToBytes32(AMOUNT + 1n)],
      },
    },
    response: VALID_RESPONSE,
    expectedSigner: MPC_ADDRESS,
    valid: false,
  },
  {
    name: "garbage scalars",
    request: REQUEST,
    response: {
      bigRx: bytes(32, 0x5a),
      bigRy: bytes(32, 0x5a),
      s: bytes(32, 0x5a),
      recoveryId: 0n,
    },
    expectedSigner: MPC_ADDRESS,
    valid: false,
  },
  {
    name: "an out-of-range recovery id",
    request: REQUEST,
    response: { ...VALID_RESPONSE, recoveryId: 5n },
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

  it("round-trips through the record encoder (R.y recovered on-curve)", () => {
    // Encode from a plain ethers signature and confirm the record decodes
    // back to a signature with the same recovered signer — exercising the
    // point-decompression path posters use.
    const signature = MPC_KEY.sign(
      signetEVMSignatureRequestToUnsignedEVMTransaction(REQUEST).unsignedHash,
    );
    const record = signatureToSignetEVMSignatureResponse(
      Signature.from(signature),
    );
    expect(record.bigRy).toHaveLength(32);
    const signed = signetEVMSignatureRequestToSignedEVMTransaction(REQUEST, record);
    expect(signed.from).toBe(MPC_ADDRESS);
  });

  it("rejects a response with an out-of-range recovery id", () => {
    expect(() =>
      signetEVMSignatureRequestToSignedEVMTransaction(REQUEST, {
        ...VALID_RESPONSE,
        recoveryId: 5n,
      }),
    ).toThrow(/recovery id/);
  });
});
