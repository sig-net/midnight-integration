// Verification of MPC signature responses against their request record: the
// unsigned EIP-1559 transaction is rebuilt exactly as the MPC assembles it,
// and the posted signature record must recover to the expected signer over
// its signing hash.

import { computeAddress, SigningKey } from "ethers";
import { describe, expect, it } from "vitest";

import {
  asciiPadded,
  evmAddressAbiWord,
  MPCDestination,
  MPCSignatureAlgorithm,
  numericAbiWord,
  recoverSignatureResponseSigner,
  type SignatureRespondedEvent,
  type SignBidirectionalEvent,
  signBidirectionalEventToUnsignedEvmTransaction,
  TxParamType,
  verifySignatureRespondedEvent,
} from "../src/index.ts";
import { ecdsaSignatureToMpcSignature } from "../src/testing.ts";

// The ERC20 transfer(address,uint256) selector: a realistic calldata fixture
// (the app-level constant lives in the cli).
const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

// ---- Fixtures ----

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

const ERC20 = bytes(20, 0xaa);
const VAULT_EVM = bytes(20, 0xee);
const AMOUNT = 1_000_000n;

/**
 * Known-good request record for a `transfer(vault, amount)` deposit: the
 * base every test varies from. Shared across tests: NEVER mutate. Build a
 * variation as an explicit spread with the delta inline.
 */
const REQUEST: SignBidirectionalEvent = {
  sender: { bytes: new Uint8Array(32) },
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
        words: [evmAddressAbiWord(VAULT_EVM), numericAbiWord(AMOUNT)],
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
): SignatureRespondedEvent => {
  const signature = key.sign(signBidirectionalEventToUnsignedEvmTransaction(request).unsignedHash);
  return {
    signature: ecdsaSignatureToMpcSignature({
      r: BigInt(signature.r),
      s: BigInt(signature.s),
      recoveryId: signature.yParity,
    }),
  };
};

const VALID_RESPONSE = signResponse(MPC_KEY, REQUEST);

/** VALID_RESPONSE with its signature's recovery id overwritten. */
const withRecoveryId = (value: bigint): SignatureRespondedEvent => ({
  signature: { ...VALID_RESPONSE.signature, recoveryId: value },
});

/** REQUEST with one calldata word swapped out. */
const withWord = (index: number, word: Uint8Array): SignBidirectionalEvent => ({
  ...REQUEST,
  txParams: {
    ...REQUEST.txParams,
    calldata: {
      is_some: true,
      value: {
        ...REQUEST.txParams.calldata.value,
        words: REQUEST.txParams.calldata.value.words.map((w, i) => (i === index ? word : w)),
      },
    },
  },
});

// ---- Tests ----

describe("recoverSignatureResponseSigner", () => {
  it("recovers the signing address from a genuine response", () => {
    expect(recoverSignatureResponseSigner(REQUEST, VALID_RESPONSE)).toBe(MPC_ADDRESS);
  });

  it("rejects a response with an out-of-range recovery id", () => {
    expect(() => recoverSignatureResponseSigner(REQUEST, withRecoveryId(5n))).toThrow(
      /recovery id/,
    );
  });

  it("rejects a request of an unsupported txParamType", () => {
    expect(() =>
      recoverSignatureResponseSigner(
        { ...REQUEST, txParamType: TxParamType.reserved },
        VALID_RESPONSE,
      ),
    ).toThrow(/unsupported txParamType 1/);
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
    request: withWord(1, numericAbiWord(AMOUNT + 1n)),
    response: VALID_RESPONSE,
    expectedSigner: MPC_ADDRESS,
    valid: false,
  },
  {
    name: "garbage scalars (a well-formed record that is no signature)",
    request: REQUEST,
    response: {
      signature: {
        bigR: { x: bytes(32, 0x5a), y: bytes(32, 0x5a) },
        s: bytes(32, 0x5a),
        recoveryId: 0n,
      },
    },
    expectedSigner: MPC_ADDRESS,
    valid: false,
  },
  {
    name: "an out-of-range recovery id",
    request: REQUEST,
    response: withRecoveryId(5n),
    expectedSigner: MPC_ADDRESS,
    valid: false,
  },
];

describe("verifySignatureRespondedEvent", () => {
  it.each(VERIFY_CASES)(
    "verdict on $name is $valid",
    ({ request, response, expectedSigner, valid }) => {
      expect(verifySignatureRespondedEvent(request, response, expectedSigner)).toBe(valid);
    },
  );
});
