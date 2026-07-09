// Golden cross-check of the word calldata assembly against ethers' canonical
// ABI encoder: for each case, words are built exactly as a client (contract
// circuit or UI) would build them, and the assembled bytes must equal
// `Interface.encodeFunctionData` output byte for byte. This is the test that
// pins the MPC re-assembly documented on `EVMCalldata` in Signet.compact —
// including the big-endian address embed (a display-order LE embed would
// assemble a byte-reversed address and fail here).

import { describe, expect, it } from "vitest";

import { getAddress, Interface, Transaction } from "ethers";

import {
  ERC20_TRANSFER_SELECTOR,
  TxParamType,
  assembleCalldata,
  bytesToHex,
  evmAddressAbiWord,
  numericAbiWordValue,
  signBidirectionalRequestToUnsignedEVMTransaction,
  type EVMType2TxParams,
  type Maybe,
  type EVMCalldata,
  type SignBidirectionalRequest,
} from "../src/index.ts";

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
        numericAbiWordValue(AMOUNT),
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
          numericAbiWordValue(AMOUNT),
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
        words: [evmAddressAbiWord(VAULT_EVM), numericAbiWordValue(AMOUNT)],
      },
    },
  };

  const request = (txParams: EVMType2TxParams): SignBidirectionalRequest => ({
    requestNonce: 0n,
    txParamType: TxParamType.evmType2,
    txParams,
    caip2Id: new Uint8Array(32),
    keyVersion: 1n,
    path: new Uint8Array(256),
    algo: new Uint8Array(32),
    dest: new Uint8Array(32),
    params: new Uint8Array(64),
    outputDeserializationSchema: new Uint8Array(128),
    respondSerializationSchema: new Uint8Array(128),
  });

  it("count-trims capacity slots and serializes round-trip", () => {
    const entryAddress = bytes(20, 0xcc);
    const key0 = bytes(32, 0x11);
    // Capacity 2 keys, only 1 in use; the second slot is zero-fill noise the
    // count must exclude.
    const tx = signBidirectionalRequestToUnsignedEVMTransaction(
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
    const tx = signBidirectionalRequestToUnsignedEVMTransaction(
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
