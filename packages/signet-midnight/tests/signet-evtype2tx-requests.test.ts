// The EVM Type-2 request module: request record -> transaction. The calldata
// assembly is golden cross-checked against ethers' canonical ABI encoder:
// for each case, words are built exactly as a client (contract circuit or
// UI) would build them, and the assembled bytes must equal
// `Interface.encodeFunctionData` output byte for byte. This pins the
// ABI-ready word convention documented on `EvmCalldata` in Signet.compact:
// words are stored in broadcast form, so assembly is a verbatim
// concatenation and the no-translation suite below proves the signed
// transaction's data IS the stored bytes, unreordered and unreinterpreted.
// The tail suites cover the full unsigned rebuild and the signed assembly
// from a posted response.

import { computeAddress, getAddress, Interface, SigningKey, Transaction } from "ethers";
import { describe, expect, it } from "vitest";

import {
  abiWordToBool,
  abiWordToUint128,
  asciiPadded,
  assembleCalldata,
  bytesToHex,
  evmAddressAbiWord,
  type EvmCalldata,
  type EvmType2TxParams,
  type Maybe,
  MPCDestination,
  MPCSignatureAlgorithm,
  numericAbiWord,
  type SignatureRespondedEvent,
  type SignBidirectionalEvent,
  signBidirectionalEventToSignedEvmTransaction,
  signBidirectionalEventToUnsignedEvmTransaction,
  TxParamType,
} from "../src/index.ts";
import { ecdsaSignatureToMpcSignature } from "../src/testing.ts";

// The ERC20 transfer(address,uint256) selector: a realistic calldata fixture
// (the app-level constant lives in the cli).
const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

const VAULT_EVM = bytes(20, 0xee);
const VAULT_ADDRESS = getAddress(`0x${"ee".repeat(20)}`);
const AMOUNT = 1_000_000n;

const someCalldata = (
  selector: Uint8Array,
  words: Uint8Array[],
  noWords = BigInt(words.length),
): Maybe<EvmCalldata> => ({
  is_some: true,
  value: { selector, noWords, words },
});

describe("assembleCalldata vs ethers encodeFunctionData", () => {
  it("static args: transfer(address,uint256), built exactly as the vault builds it", () => {
    const iface = new Interface(["function transfer(address,uint256)"]);
    const expected = iface.encodeFunctionData("transfer", [VAULT_ADDRESS, AMOUNT]);

    const assembled = assembleCalldata(
      someCalldata(ERC20_TRANSFER_SELECTOR, [evmAddressAbiWord(VAULT_EVM), numericAbiWord(AMOUNT)]),
    );

    expect(assembled).toBe(expected);
  });

  it("drops capacity slots beyond noWords", () => {
    const iface = new Interface(["function transfer(address,uint256)"]);
    const expected = iface.encodeFunctionData("transfer", [VAULT_ADDRESS, AMOUNT]);

    // Two real words in a 4-word capacity; the trailing zero-fill is excluded.
    const assembled = assembleCalldata(
      someCalldata(
        ERC20_TRANSFER_SELECTOR,
        [
          evmAddressAbiWord(VAULT_EVM),
          numericAbiWord(AMOUNT),
          new Uint8Array(32),
          new Uint8Array(32),
        ],
        2n,
      ),
    );

    expect(assembled).toBe(expected);
  });

  it("no calldata: assembles to 0x (plain ETH transfer)", () => {
    expect(
      assembleCalldata({
        is_some: false,
        value: { selector: new Uint8Array(4), noWords: 0n, words: [] },
      }),
    ).toBe("0x");
  });
});

describe("no translation between stored record and signed transaction", () => {
  it("tx data is the stored selector and words, byte for byte", () => {
    // Deliberately arbitrary word bytes (not built by any helper): whatever
    // the contract stored must reach the transaction untouched.
    const word0 = Uint8Array.from({ length: 32 }, (_, i) => 0xd0 + (i % 16));
    const word1 = Uint8Array.from({ length: 32 }, (_, i) => 0x7f - (i % 32));
    const to = bytes(20, 0xaa);
    const tx = signBidirectionalEventToUnsignedEvmTransaction({
      sender: { bytes: new Uint8Array(32) },
      requestNonce: 0n,
      keyVersion: 1n,
      path: new Uint8Array(32),
      algo: MPCSignatureAlgorithm.ecdsa,
      dest: MPCDestination.unused,
      params: new Uint8Array(64),
      txParamType: TxParamType.evmType2,
      txParams: {
        to,
        chainId: 11155111n,
        nonce: 7n,
        gasLimit: 100_000n,
        maxFeePerGas: 30_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        value: 0n,
        accessListEntryCount: 0n,
        accessList: [],
        calldata: someCalldata(ERC20_TRANSFER_SELECTOR, [word0, word1]),
      },
      caip2Id: new Uint8Array(32),
      outputDeserializationSchema: new Uint8Array(34),
      respondSerializationSchema: new Uint8Array(34),
    });

    expect(tx.data).toBe(
      `0x${bytesToHex(ERC20_TRANSFER_SELECTOR)}${bytesToHex(word0)}${bytesToHex(word1)}`,
    );
    expect(tx.to).toBe(getAddress(`0x${bytesToHex(to)}`));
  });
});

describe("access list in the rebuilt transaction", () => {
  const baseTxParams: EvmType2TxParams = {
    to: bytes(20, 0xaa),
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
  };

  const request = (txParams: EvmType2TxParams): SignBidirectionalEvent => ({
    sender: { bytes: new Uint8Array(32) },
    requestNonce: 0n,
    keyVersion: 1n,
    path: new Uint8Array(32),
    algo: MPCSignatureAlgorithm.ecdsa,
    dest: MPCDestination.unused,
    params: new Uint8Array(64),
    txParamType: TxParamType.evmType2,
    txParams,
    caip2Id: new Uint8Array(32),
    outputDeserializationSchema: new Uint8Array(34),
    respondSerializationSchema: new Uint8Array(34),
  });

  it("count-trims capacity slots and serializes round-trip", () => {
    const entryAddress = bytes(20, 0xcc);
    const key0 = bytes(32, 0x11);
    // Capacity 2 keys, only 1 in use; the second slot is zero-fill noise the
    // count must exclude.
    const tx = signBidirectionalEventToUnsignedEvmTransaction(
      request({
        ...baseTxParams,
        accessListEntryCount: 1n,
        accessList: [
          {
            address: entryAddress,
            storageKeyCount: 1n,
            storageKeys: [key0, new Uint8Array(32)],
          },
        ],
      }),
    );

    expect(tx.accessList).toEqual([
      {
        address: getAddress(`0x${bytesToHex(entryAddress)}`),
        storageKeys: [`0x${bytesToHex(key0)}`],
      },
    ]);
    // The serialized form round-trips through ethers with the list intact.
    const reparsed = Transaction.from(tx.unsignedSerialized);
    expect(reparsed.accessList).toEqual(tx.accessList);
  });

  it("an all-capacity-unused access list serializes as empty", () => {
    const tx = signBidirectionalEventToUnsignedEvmTransaction(
      request({
        ...baseTxParams,
        accessList: [
          {
            address: new Uint8Array(20),
            storageKeyCount: 0n,
            storageKeys: [new Uint8Array(32)],
          },
        ],
      }),
    );
    expect(tx.accessList).toEqual([]);
  });
});

// ---- Unsigned rebuild + signed assembly fixtures ----

const ERC20 = bytes(20, 0xaa);

/**
 * Known-good request record for a `transfer(vault, amount)` deposit: the
 * base of the unsigned/signed assembly suites. Shared across tests: NEVER
 * mutate.
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
        words: [evmAddressAbiWord(VAULT_EVM), numericAbiWord(AMOUNT)],
      },
    },
  },
  caip2Id: asciiPadded("eip155:11155111", 32),
  outputDeserializationSchema: new Uint8Array(34),
  respondSerializationSchema: new Uint8Array(34),
};

// The "MPC" of the signed-assembly suite: a plain secp256k1 key standing in
// for the user's derived signer.
const MPC_KEY = new SigningKey(`0x${"11".repeat(32)}`);
const MPC_ADDRESS = computeAddress(MPC_KEY.publicKey);

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

describe("signBidirectionalEventToUnsignedEvmTransaction", () => {
  it("rebuilds the exact EIP-1559 transaction the request describes", () => {
    const tx = signBidirectionalEventToUnsignedEvmTransaction(REQUEST);

    expect(tx.type).toBe(2);
    expect(tx.chainId).toBe(11155111n);
    expect(tx.nonce).toBe(7);
    expect(tx.gasLimit).toBe(100_000n);
    expect(tx.maxFeePerGas).toBe(30_000_000_000n);
    expect(tx.maxPriorityFeePerGas).toBe(1_000_000_000n);
    expect(tx.value).toBe(0n);
    expect(tx.to?.toLowerCase()).toBe(`0x${"aa".repeat(20)}`);
    expect(tx.accessList).toEqual([]);

    // The calldata decodes back to the transfer args: the address in
    // display order (proving the BE address embed) and the amount.
    const iface = new Interface(["function transfer(address,uint256)"]);
    const [to, amount] = iface.decodeFunctionData("transfer", tx.data);
    expect((to as string).toLowerCase()).toBe(`0x${"ee".repeat(20)}`);
    expect(amount).toBe(AMOUNT);
  });
});

describe("signBidirectionalEventToSignedEvmTransaction", () => {
  it("attaches the response signature to the request's transaction", () => {
    const signed = signBidirectionalEventToSignedEvmTransaction(REQUEST, VALID_RESPONSE);

    expect(signed.isSigned()).toBe(true);
    // Signing is non-destructive: the signed tx carries the same body as the
    // unsigned one, so its signing hash is unchanged.
    expect(signed.unsignedHash).toBe(
      signBidirectionalEventToUnsignedEvmTransaction(REQUEST).unsignedHash,
    );
    // The attached signature recovers to the MPC signer...
    expect(signed.from).toBe(MPC_ADDRESS);
    // ...and the serialized payload round-trips to the same signed tx, i.e.
    // it is broadcast-ready for eth_sendRawTransaction.
    const roundTripped = Transaction.from(signed.serialized);
    expect(roundTripped.from).toBe(MPC_ADDRESS);
    expect(roundTripped.hash).toBe(signed.hash);
  });

  it("rejects a response with an out-of-range recovery id", () => {
    expect(() => signBidirectionalEventToSignedEvmTransaction(REQUEST, withRecoveryId(5n))).toThrow(
      /recovery id/,
    );
  });
});

describe("ABI word helpers: rejection rows", () => {
  it("evmAddressAbiWord rejects an address that is not 20 bytes", () => {
    expect(() => evmAddressAbiWord(bytes(19, 0xaa))).toThrow(/EVM address must be 20 bytes/);
    expect(() => evmAddressAbiWord(bytes(21, 0xaa))).toThrow(/EVM address must be 20 bytes/);
  });

  it("abiWordToUint128 rejects a word that is not 32 bytes", () => {
    expect(() => abiWordToUint128(bytes(16, 0))).toThrow(/ABI word must be 32 bytes/);
  });

  it("abiWordToUint128 rejects a non-zero leading half", () => {
    const word = new Uint8Array(32);
    word[15] = 1;
    expect(() => abiWordToUint128(word)).toThrow(/ABI word exceeds Uint<128>/);
  });

  it("abiWordToBool rejects a word that is not 32 bytes", () => {
    expect(() => abiWordToBool(bytes(31, 0))).toThrow(/ABI word must be 32 bytes/);
  });

  it("abiWordToBool rejects a non-canonical Boolean", () => {
    const word = new Uint8Array(32);
    word[31] = 2;
    expect(() => abiWordToBool(word)).toThrow(/ABI word is not a canonical Boolean/);
  });
});
