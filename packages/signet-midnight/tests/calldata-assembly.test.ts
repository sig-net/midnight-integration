// Golden cross-check of the word calldata assembly against ethers' canonical
// ABI encoder: for each case, words are built exactly as a client (contract
// circuit or UI) would build them, and the assembled bytes must equal
// `Interface.encodeFunctionData` output byte for byte. This pins the
// ABI-ready word convention documented on `EVMCalldata` in Signet.compact:
// words are stored in broadcast form, so assembly is a verbatim
// concatenation and the no-translation suite below proves the signed
// transaction's data IS the stored bytes, unreordered and unreinterpreted.

import { describe, expect, it } from "vitest";

import { getAddress, Interface, Transaction } from "ethers";

import {
  MPCDestination,
  MPCSignatureAlgorithm,
  TxParamType,
  assembleCalldata,
  bytesToHex,
  evmAddressAbiWord,
  numericAbiWord,
  signBidirectionalEventToUnsignedEVMTransaction,
  type EVMType2TxParams,
  type Maybe,
  type EVMCalldata,
  type SignBidirectionalEvent,
} from "../src/index.ts";

// The ERC20 transfer(address,uint256) selector — a realistic calldata fixture
// (the app-level constant lives in the cli, not the SDK).
const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

const VAULT_EVM = bytes(20, 0xee);
const VAULT_ADDRESS = getAddress(`0x${"ee".repeat(20)}`);
const AMOUNT = 1_000_000n;

const someCalldata = (
  selector: Uint8Array,
  words: Uint8Array[],
  noWords: bigint = BigInt(words.length),
): Maybe<EVMCalldata> => ({
  is_some: true,
  value: { selector, noWords, words },
});

describe("assembleCalldata vs ethers encodeFunctionData", () => {
  it("static args: transfer(address,uint256), built exactly as the vault builds it", () => {
    const iface = new Interface(["function transfer(address,uint256)"]);
    const expected = iface.encodeFunctionData("transfer", [
      VAULT_ADDRESS,
      AMOUNT,
    ]);

    const assembled = assembleCalldata(
      someCalldata(ERC20_TRANSFER_SELECTOR, [
        evmAddressAbiWord(VAULT_EVM),
        numericAbiWord(AMOUNT),
      ]),
    );

    expect(assembled).toBe(expected);
  });

  it("drops capacity slots beyond noWords", () => {
    const iface = new Interface(["function transfer(address,uint256)"]);
    const expected = iface.encodeFunctionData("transfer", [
      VAULT_ADDRESS,
      AMOUNT,
    ]);

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
    const tx = signBidirectionalEventToUnsignedEVMTransaction({
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
  const baseTxParams: EVMType2TxParams = {
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

  const request = (txParams: EVMType2TxParams): SignBidirectionalEvent => ({
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
    const tx = signBidirectionalEventToUnsignedEVMTransaction(
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
    const tx = signBidirectionalEventToUnsignedEVMTransaction(
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
