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
  MPCDestination,
  MPCSignatureAlgorithm,
  TxParamType,
  asciiPadded,
  evmAddressAbiWord,
  numericAbiWordValue,
  signatureToSignatureRespondedEvent,
  signBidirectionalEventToSignedEVMTransaction,
  signBidirectionalEventToUnsignedEVMTransaction,
  recoverSignatureResponseSigner,
  verifySignatureRespondedEvent,
  type SignBidirectionalEvent,
  type SignatureRespondedEvent,
} from "../src/index.ts";

// The ERC20 transfer(address,uint256) selector — a realistic calldata fixture
// (the app-level constant lives in the cli, not the SDK).
const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

// ---- Fixtures ----

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

const ERC20 = bytes(20, 0xaa);
const VAULT_EVM = bytes(20, 0xee);
const AMOUNT = 1_000_000n;

/**
 * Known-good request record for a `transfer(vault, amount)` deposit — the
 * base every test varies from. Shared across tests: NEVER mutate; build a
 * variation as an explicit spread with the delta inline.
 */
const REQUEST: SignBidirectionalEvent = {
  sender: { bytes: new Uint8Array(32) },
  requestNonce: 0n,
  keyVersion: 1n,
  path: new Uint8Array(32),
  algo: MPCSignatureAlgorithm.ecdsa,
  dest: MPCDestination.unused,
  params: new Uint8Array(64),
  txParamType: TxParamType.evmType2,
  txParams: {
    to: ERC20,
    chainId: 11155111n,
    nonce: 7n,
    gasLimit: 100_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    value: 0n,
    accessListEntryCount: 0n,
    accessList: [],
    calldata: {
      is_some: true,
      value: {
        selector: ERC20_TRANSFER_SELECTOR,
        noWords: 2n,
        words: [evmAddressAbiWord(VAULT_EVM), numericAbiWordValue(AMOUNT)],
      },
    },
  },
  caip2Id: asciiPadded("eip155:11155111", 32),
  outputDeserializationSchema: new Uint8Array(34),
  respondSerializationSchema: new Uint8Array(34),
};

// The "MPC" of these tests: a plain secp256k1 key standing in for the
// user's derived signer, plus a second key playing the imposter.
const MPC_KEY = new SigningKey(`0x${"11".repeat(32)}`);
const MPC_ADDRESS = computeAddress(MPC_KEY.publicKey);
const IMPOSTER_KEY = new SigningKey(`0x${"22".repeat(32)}`);

/** Sign `request`'s rebuilt tx hash with `key`, packed as a response record. */
const signResponse = (
  key: SigningKey,
  request: SignBidirectionalEvent,
): SignatureRespondedEvent =>
  signatureToSignatureRespondedEvent(
    key.sign(
      signBidirectionalEventToUnsignedEVMTransaction(request).unsignedHash,
    ),
  );

const VALID_RESPONSE = signResponse(MPC_KEY, REQUEST);

/** REQUEST with one calldata word swapped out. */
const withWord = (
  index: number,
  word: Uint8Array,
): SignBidirectionalEvent => ({
  ...REQUEST,
  txParams: {
    ...REQUEST.txParams,
    calldata: {
      is_some: true,
      value: {
        ...REQUEST.txParams.calldata.value,
        words: REQUEST.txParams.calldata.value.words.map((w, i) =>
          i === index ? word : w,
        ),
      },
    },
  },
});

// ---- Tests ----

describe("signBidirectionalEventToUnsignedEVMTransaction", () => {
  it("rebuilds the exact EIP-1559 transaction the request describes", () => {
    const tx = signBidirectionalEventToUnsignedEVMTransaction(REQUEST);

    expect(tx.type).toBe(2);
    expect(tx.chainId).toBe(11155111n);
    expect(tx.nonce).toBe(7);
    expect(tx.gasLimit).toBe(100_000n);
    expect(tx.maxFeePerGas).toBe(30_000_000_000n);
    expect(tx.maxPriorityFeePerGas).toBe(1_000_000_000n);
    expect(tx.value).toBe(0n);
    expect(tx.to?.toLowerCase()).toBe(`0x${"aa".repeat(20)}`);
    expect(tx.accessList).toEqual([]);

    // The calldata decodes back to the transfer args — the address in
    // display order (proving the BE address embed) and the amount.
    const iface = new Interface(["function transfer(address,uint256)"]);
    const [to, amount] = iface.decodeFunctionData("transfer", tx.data);
    expect((to as string).toLowerCase()).toBe(`0x${"ee".repeat(20)}`);
    expect(amount).toBe(AMOUNT);
  });
});

describe("recoverSignatureResponseSigner", () => {
  it("recovers the signing address from a genuine response", () => {
    expect(recoverSignatureResponseSigner(REQUEST, VALID_RESPONSE)).toBe(
      MPC_ADDRESS,
    );
  });

  it("rejects a response with an out-of-range recovery id", () => {
    expect(() =>
      recoverSignatureResponseSigner(REQUEST, {
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
  request: SignBidirectionalEvent;
  /** The candidate response record. */
  response: SignatureRespondedEvent;
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
    request: withWord(1, numericAbiWordValue(AMOUNT + 1n)),
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

describe("verifySignatureRespondedEvent", () => {
  it.each(VERIFY_CASES)(
    "verdict on $name is $valid",
    ({ request, response, expectedSigner, valid }) => {
      expect(
        verifySignatureRespondedEvent(request, response, expectedSigner),
      ).toBe(valid);
    },
  );
});

describe("signBidirectionalEventToSignedEVMTransaction", () => {
  it("attaches the response signature to the request's transaction", () => {
    const signed = signBidirectionalEventToSignedEVMTransaction(
      REQUEST,
      VALID_RESPONSE,
    );

    expect(signed.isSigned()).toBe(true);
    // Signing is non-destructive: the signed tx carries the same body as the
    // unsigned one, so its signing hash is unchanged.
    expect(signed.unsignedHash).toBe(
      signBidirectionalEventToUnsignedEVMTransaction(REQUEST).unsignedHash,
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
      signBidirectionalEventToUnsignedEVMTransaction(REQUEST).unsignedHash,
    );
    const record = signatureToSignatureRespondedEvent(
      Signature.from(signature),
    );
    expect(record.bigRy).toHaveLength(32);
    const signed = signBidirectionalEventToSignedEVMTransaction(REQUEST, record);
    expect(signed.from).toBe(MPC_ADDRESS);
  });

  it("rejects a response with an out-of-range recovery id", () => {
    expect(() =>
      signBidirectionalEventToSignedEVMTransaction(REQUEST, {
        ...VALID_RESPONSE,
        recoveryId: 5n,
      }),
    ).toThrow(/recovery id/);
  });
});
