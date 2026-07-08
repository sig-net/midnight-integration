// Golden cross-check of the tagged-word calldata assembly against ethers'
// canonical ABI encoder: for each case, words are built exactly as a client
// (contract circuit or UI) would build them, and the assembled bytes must
// equal `Interface.encodeFunctionData` output byte for byte. This is the test
// that pins the MPC re-assembly contract documented on `EVMCalldata` in
// Signet.compact — including the big-endian address embed (a display-order
// LE embed would assemble a byte-reversed address and fail here).

import { describe, expect, it } from "vitest";

import { getAddress, Interface, Transaction } from "ethers";

import {
  ABIWordKind,
  ERC20_TRANSFER_SELECTOR,
  TxParamType,
  assembleCalldata,
  bytesToHex,
  evmAddressAbiWord,
  numericAbiWordValue,
  signBidirectionalEventToUnsignedEVMTransaction,
  type ABIWord,
  type EVMType2TxParams,
  type Maybe,
  type EVMCalldata,
  type SignBidirectionalEvent,
} from "../src/index.ts";

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

const VAULT_EVM = bytes(20, 0xee);
const VAULT_ADDRESS = getAddress(`0x${"ee".repeat(20)}`);
const AMOUNT = 1_000_000n;

const someCalldata = (
  selector: Uint8Array,
  words: ABIWord[],
): Maybe<EVMCalldata> => ({
  is_some: true,
  value: { selector, words },
});

/** The first 4 bytes of `Interface`'s encoding for `signature` — the selector. */
const selectorOf = (iface: Interface, name: string): Uint8Array => {
  const fragment = iface.getFunction(name);
  if (fragment === null) throw new Error(`no function ${name}`);
  return Uint8Array.from(Buffer.from(fragment.selector.slice(2), "hex"));
};

describe("assembleCalldata vs ethers encodeFunctionData", () => {
  it("static args: transfer(address,uint256), built exactly as the vault builds it", () => {
    const iface = new Interface(["function transfer(address,uint256)"]);
    const expected = iface.encodeFunctionData("transfer", [
      VAULT_ADDRESS,
      AMOUNT,
    ]);

    const assembled = assembleCalldata(
      someCalldata(ERC20_TRANSFER_SELECTOR, [
        { kind: ABIWordKind.staticArg, value: evmAddressAbiWord(VAULT_EVM) },
        { kind: ABIWordKind.staticArg, value: numericAbiWordValue(AMOUNT) },
      ]),
    );

    expect(assembled).toBe(expected);
  });

  it("head/tail: a dynamic bytes arg, offsets and chunks client-built", () => {
    const iface = new Interface([
      "function transferAndCall(address,uint256,bytes)",
    ]);
    // A 40-byte payload: 2 verbatim data chunks, the tail zero-padded.
    const payload = Uint8Array.from({ length: 40 }, (_, i) => i + 1);
    const expected = iface.encodeFunctionData("transferAndCall", [
      VAULT_ADDRESS,
      AMOUNT,
      payload,
    ]);

    const chunk0 = payload.slice(0, 32);
    const chunk1 = new Uint8Array(32);
    chunk1.set(payload.slice(32));

    const assembled = assembleCalldata(
      someCalldata(selectorOf(iface, "transferAndCall"), [
        { kind: ABIWordKind.staticArg, value: evmAddressAbiWord(VAULT_EVM) },
        { kind: ABIWordKind.staticArg, value: numericAbiWordValue(AMOUNT) },
        // Head slot: byte offset of the bytes tail = 3 head slots * 32.
        { kind: ABIWordKind.dynArgHead, value: numericAbiWordValue(96n) },
        { kind: ABIWordKind.dynArgLength, value: numericAbiWordValue(40n) },
        { kind: ABIWordKind.dynArgData, value: chunk0 },
        { kind: ABIWordKind.dynArgData, value: chunk1 },
        // Capacity fill beyond the call's real words — dropped on assembly.
        { kind: ABIWordKind.unused, value: new Uint8Array(32) },
        { kind: ABIWordKind.unused, value: new Uint8Array(32) },
      ]),
    );

    expect(assembled).toBe(expected);
  });

  it("head/tail: a dynamic uint256[] arg", () => {
    const iface = new Interface(["function batch(uint256[])"]);
    const values = [7n, 11n, 13n];
    const expected = iface.encodeFunctionData("batch", [values]);

    const assembled = assembleCalldata(
      someCalldata(selectorOf(iface, "batch"), [
        { kind: ABIWordKind.dynArgHead, value: numericAbiWordValue(32n) },
        { kind: ABIWordKind.dynArgLength, value: numericAbiWordValue(3n) },
        // Array elements are 32-byte numeric words — LE-embedded like any
        // other numeric word, re-encoded big-endian on assembly.
        { kind: ABIWordKind.staticArg, value: numericAbiWordValue(7n) },
        { kind: ABIWordKind.staticArg, value: numericAbiWordValue(11n) },
        { kind: ABIWordKind.staticArg, value: numericAbiWordValue(13n) },
      ]),
    );

    expect(assembled).toBe(expected);
  });

  it("no calldata: assembles to 0x (plain ETH transfer)", () => {
    expect(
      assembleCalldata({
        is_some: false,
        value: { selector: new Uint8Array(4), words: [] },
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
        words: [
          { kind: ABIWordKind.staticArg, value: evmAddressAbiWord(VAULT_EVM) },
          { kind: ABIWordKind.staticArg, value: numericAbiWordValue(AMOUNT) },
        ],
      },
    },
  };

  const event = (txParams: EVMType2TxParams): SignBidirectionalEvent => ({
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
    const tx = signBidirectionalEventToUnsignedEVMTransaction(
      event({
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
      event({
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
