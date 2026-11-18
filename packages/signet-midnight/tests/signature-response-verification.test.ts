// Verification of MPC signature responses against their request record: the
// unsigned EIP-1559 or Tron transaction is rebuilt exactly as the MPC
// assembles it, and the posted signature record must recover to the expected signer over
// its signing hash.

import { computeAddress, SigningKey } from "ethers";
import { describe, expect, it } from "vitest";

import {
  buildTronRawTransaction,
  bytesToHex,
  calculateRequestId,
  deriveEpsilon,
  deriveSignBidirectionalEventSignerEvmAddress,
  deriveSignBidirectionalEventSignerTronAddress,
  evmAddressAbiWord,
  MPCDestination,
  MPCSignatureAlgorithm,
  numericAbiWord,
  pureCircuits,
  recoverEvmSignatureResponseSigner,
  recoverTronSignatureResponseSigner,
  SECP256K1_ORDER,
  type SignatureRespondedEvent,
  type SignBidirectionalEvent,
  signBidirectionalEventToUnsignedEvmTransaction,
  tronAddressFromEvm,
  tronAddressToBase58,
  tronTransactionId,
  type TronTxParams,
  TxParamType,
  verifyEvmSignatureRespondedEvent,
  verifyTronSignatureRespondedEvent,
} from "../src/index.ts";
import { ecdsaSignatureToMpcSignature } from "../src/testing.ts";

// The ERC20 transfer(address,uint256) selector: a realistic calldata fixture.
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
  signatureDest: MPCDestination.unused,
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
  executionDest: pureCircuits.ethereumCaip2Id(),
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
    requestId: calculateRequestId(request),
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
  ...VALID_RESPONSE,
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

describe("recoverEvmSignatureResponseSigner", () => {
  it("recovers the signing address from a genuine response", () => {
    expect(recoverEvmSignatureResponseSigner(REQUEST, VALID_RESPONSE)).toBe(MPC_ADDRESS);
  });

  it("rejects a response with an out-of-range recovery id", () => {
    expect(() => recoverEvmSignatureResponseSigner(REQUEST, withRecoveryId(5n))).toThrow(
      /recovery id/,
    );
  });

  it("rejects a request that is not evmType2", () => {
    expect(() =>
      recoverEvmSignatureResponseSigner(
        { ...REQUEST, txParamType: TxParamType.tron },
        VALID_RESPONSE,
      ),
    ).toThrow(/expected an evmType2 request record, got txParamType 1/);
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
      requestId: bytes(32, 0x5a),
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

describe("verifyEvmSignatureRespondedEvent", () => {
  it.each(VERIFY_CASES)(
    "verdict on $name is $valid",
    ({ request, response, expectedSigner, valid }) => {
      expect(verifyEvmSignatureRespondedEvent(request, response, expectedSigner)).toBe(valid);
    },
  );

  it("throws on a request that is not evmType2", () => {
    expect(() =>
      verifyEvmSignatureRespondedEvent(
        { ...REQUEST, txParamType: TxParamType.tron },
        VALID_RESPONSE,
        MPC_ADDRESS,
      ),
    ).toThrow(/expected an evmType2 request record/);
  });
});

const TRON_REQUEST: SignBidirectionalEvent<TronTxParams> = {
  ...REQUEST,
  txParamType: TxParamType.tron,
  txParams: {
    refBlockBytes: Uint8Array.from([0x27, 0x10]),
    refBlockHash: bytes(8, 0x42),
    timestamp: 1_728_000_000_000n,
    expiration: 1_728_000_060_000n,
    feeLimit: 50_000_000n,
    contractAddress: tronAddressFromEvm(ERC20),
    callValue: 0n,
    calldata: REQUEST.txParams.calldata,
  },
  executionDest: pureCircuits.tronCaip2Id(),
  outputDeserializationSchema: new Uint8Array(0),
  respondSerializationSchema: new Uint8Array(0),
};

// The Tron owner is derived from a root key and the record's sender and path,
// so these tests sign with the derived child secret of a known root.
const MPC_ROOT_SECRET = BigInt(`0x${"11".repeat(32)}`);
const MPC_ROOT_PUBLIC_KEY = new SigningKey(`0x${"11".repeat(32)}`).publicKey;
const MPC_CHILD_KEY = new SigningKey(
  `0x${(
    (MPC_ROOT_SECRET +
      deriveEpsilon(bytesToHex(TRON_REQUEST.sender.bytes), bytesToHex(TRON_REQUEST.path))) %
    SECP256K1_ORDER
  )
    .toString(16)
    .padStart(64, "0")}`,
);
const MPC_CHILD_ADDRESS = computeAddress(MPC_CHILD_KEY.publicKey);
const MPC_TRON_ADDRESS = tronAddressToBase58(tronAddressFromEvm(MPC_CHILD_ADDRESS));
const IMPOSTER_ROOT_PUBLIC_KEY = IMPOSTER_KEY.publicKey;

const signTronResponse = (
  key: SigningKey,
  request: SignBidirectionalEvent<TronTxParams>,
  owner: string,
): SignatureRespondedEvent => {
  const owner21 = tronAddressFromEvm(owner);
  const signature = key.sign(tronTransactionId(buildTronRawTransaction(request.txParams, owner21)));
  return {
    requestId: calculateRequestId(request),
    signature: ecdsaSignatureToMpcSignature({
      r: BigInt(signature.r),
      s: BigInt(signature.s),
      recoveryId: signature.yParity,
    }),
  };
};

const VALID_TRON_RESPONSE = signTronResponse(MPC_CHILD_KEY, TRON_REQUEST, MPC_CHILD_ADDRESS);

describe("recoverTronSignatureResponseSigner", () => {
  it("signs from the owner the record and root key derive", () => {
    expect(deriveSignBidirectionalEventSignerEvmAddress(MPC_ROOT_PUBLIC_KEY, TRON_REQUEST)).toBe(
      MPC_CHILD_ADDRESS,
    );
    expect(
      deriveSignBidirectionalEventSignerTronAddress(MPC_ROOT_PUBLIC_KEY, TRON_REQUEST).base58,
    ).toBe(MPC_TRON_ADDRESS);
  });

  it("recovers the owner's base58 address from a genuine response", () => {
    expect(
      recoverTronSignatureResponseSigner(TRON_REQUEST, VALID_TRON_RESPONSE, MPC_ROOT_PUBLIC_KEY),
    ).toBe(MPC_TRON_ADDRESS);
  });

  it("refuses a root key that does not parse", () => {
    expect(() =>
      recoverTronSignatureResponseSigner(TRON_REQUEST, VALID_TRON_RESPONSE, MPC_TRON_ADDRESS),
    ).toThrow();
  });

  it("refuses an evmType2 request", () => {
    expect(() =>
      recoverTronSignatureResponseSigner(
        REQUEST as unknown as SignBidirectionalEvent<TronTxParams>,
        VALID_TRON_RESPONSE,
        MPC_ROOT_PUBLIC_KEY,
      ),
    ).toThrow(/expected a Tron request record, got txParamType 0/);
  });

  it("recoverEvmSignatureResponseSigner refuses a Tron request: its digest names the owner", () => {
    expect(() =>
      recoverEvmSignatureResponseSigner(
        TRON_REQUEST as unknown as SignBidirectionalEvent,
        VALID_TRON_RESPONSE,
      ),
    ).toThrow(/expected an evmType2 request record, got txParamType 1/);
  });
});

interface TronVerifyCase {
  name: string;
  request: SignBidirectionalEvent<TronTxParams>;
  response: SignatureRespondedEvent;
  mpcRootPublicKey: string;
  valid: boolean;
}

const TRON_VERIFY_CASES: TronVerifyCase[] = [
  {
    name: "a genuine response",
    request: TRON_REQUEST,
    response: VALID_TRON_RESPONSE,
    mpcRootPublicKey: MPC_ROOT_PUBLIC_KEY,
    valid: true,
  },
  {
    name: "a response signed by another key",
    request: TRON_REQUEST,
    response: signTronResponse(IMPOSTER_KEY, TRON_REQUEST, MPC_CHILD_ADDRESS),
    mpcRootPublicKey: MPC_ROOT_PUBLIC_KEY,
    valid: false,
  },
  {
    name: "the imposter's signature over its own transaction, claimed for the MPC's",
    request: TRON_REQUEST,
    response: signTronResponse(IMPOSTER_KEY, TRON_REQUEST, computeAddress(IMPOSTER_KEY.publicKey)),
    mpcRootPublicKey: MPC_ROOT_PUBLIC_KEY,
    valid: false,
  },
  {
    name: "a genuine signature checked against another root key",
    request: TRON_REQUEST,
    response: VALID_TRON_RESPONSE,
    mpcRootPublicKey: IMPOSTER_ROOT_PUBLIC_KEY,
    valid: false,
  },
  {
    name: "a genuine signature over a DIFFERENT request (raised fee limit)",
    request: { ...TRON_REQUEST, txParams: { ...TRON_REQUEST.txParams, feeLimit: 60_000_000n } },
    response: VALID_TRON_RESPONSE,
    mpcRootPublicKey: MPC_ROOT_PUBLIC_KEY,
    valid: false,
  },
  {
    name: "a genuine signature for another derivation path",
    request: { ...TRON_REQUEST, path: new Uint8Array(32).fill(0x01) },
    response: VALID_TRON_RESPONSE,
    mpcRootPublicKey: MPC_ROOT_PUBLIC_KEY,
    valid: false,
  },
  {
    name: "an out-of-range recovery id",
    request: TRON_REQUEST,
    response: {
      ...VALID_TRON_RESPONSE,
      signature: { ...VALID_TRON_RESPONSE.signature, recoveryId: 5n },
    },
    mpcRootPublicKey: MPC_ROOT_PUBLIC_KEY,
    valid: false,
  },
];

describe("verifyTronSignatureRespondedEvent", () => {
  it.each(TRON_VERIFY_CASES)(
    "verdict on $name is $valid",
    ({ request, response, mpcRootPublicKey, valid }) => {
      expect(verifyTronSignatureRespondedEvent(request, response, mpcRootPublicKey)).toBe(valid);
    },
  );

  it("throws on an evmType2 request", () => {
    expect(() =>
      verifyTronSignatureRespondedEvent(
        REQUEST as unknown as SignBidirectionalEvent<TronTxParams>,
        VALID_TRON_RESPONSE,
        MPC_ROOT_PUBLIC_KEY,
      ),
    ).toThrow(/expected a Tron request record/);
  });
});
