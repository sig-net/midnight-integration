// signBidirectionalEventToUnsignedTronTransaction against the MPC's own request-id hashing,
// owner derivation and raw assembly (chain-midnight generate_sign_request at the commit the
// fixture names), on vault-shaped Tron withdraw records.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  bytesToHex,
  calculateRequestId,
  hexToBytes,
  MPC_PARAMS_BYTES,
  MPCDestination,
  MPCSignatureAlgorithm,
  pureCircuits,
  type SignBidirectionalEvent,
  signBidirectionalEventToUnsignedTronTransaction,
  type TronTxParams,
  TxParamType,
} from "../src/index.ts";

interface UnsignedGoldenFixture {
  mpcCommit: string;
  rootPublicKey: string;
  transactions: {
    name: string;
    record: {
      keyVersion: number;
      sender: string;
      path: string;
      txParams: {
        refBlockBytes: string;
        refBlockHash: string;
        timestamp: string;
        expiration: string;
        feeLimit: string;
        contractAddress: string;
        callValue: string;
        calldata: { isSome: boolean; selector: string; noWords: number; words: string[] };
      };
      outputDeserializationSchema: string;
    };
    requestId: string;
    owner: string;
    raw: string;
    txid: string;
  }[];
}

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/tron-unsigned-mpc-3d586f3.json", import.meta.url), "utf8"),
) as UnsignedGoldenFixture;

const CASES = FIXTURE.transactions.map(({ name, record, requestId, owner, raw, txid }) => ({
  name,
  request: {
    keyVersion: BigInt(record.keyVersion),
    sender: { bytes: hexToBytes(record.sender) },
    path: hexToBytes(record.path),
    algo: MPCSignatureAlgorithm.ecdsa,
    txParamType: TxParamType.tron,
    txParams: {
      refBlockBytes: hexToBytes(record.txParams.refBlockBytes),
      refBlockHash: hexToBytes(record.txParams.refBlockHash),
      timestamp: BigInt(record.txParams.timestamp),
      expiration: BigInt(record.txParams.expiration),
      feeLimit: BigInt(record.txParams.feeLimit),
      contractAddress: hexToBytes(record.txParams.contractAddress),
      callValue: BigInt(record.txParams.callValue),
      calldata: {
        is_some: record.txParams.calldata.isSome,
        value: {
          selector: hexToBytes(record.txParams.calldata.selector),
          noWords: BigInt(record.txParams.calldata.noWords),
          words: record.txParams.calldata.words.map(hexToBytes),
        },
      },
    },
    executionDest: pureCircuits.tronCaip2Id(),
    signatureDest: MPCDestination.unused,
    params: new Uint8Array(MPC_PARAMS_BYTES),
    outputDeserializationSchema: hexToBytes(record.outputDeserializationSchema),
    respondSerializationSchema: new Uint8Array(0),
  } satisfies SignBidirectionalEvent<TronTxParams>,
  requestId,
  owner,
  raw,
  txid,
}));

describe(`signBidirectionalEventToUnsignedTronTransaction (sig-net/mpc ${FIXTURE.mpcCommit})`, () => {
  it("names the MPC commit the vectors were generated at", () => {
    expect(FIXTURE.mpcCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(CASES.map(({ name }) => name)).toEqual([
      "vault_withdraw",
      "int64_edges",
      "zero_fee_limit_no_calldata",
    ]);
  });

  it.each(CASES)("$name: the record is the one the MPC hashed", ({ request, requestId }) => {
    expect(bytesToHex(calculateRequestId(request))).toBe(requestId);
  });

  it.each(CASES)(
    "$name: rebuilds the MPC's raw bytes, id and owner",
    ({ request, owner, raw, txid }) => {
      const unsigned = signBidirectionalEventToUnsignedTronTransaction(
        request,
        FIXTURE.rootPublicKey,
      );
      expect(bytesToHex(unsigned.raw)).toBe(raw);
      expect(bytesToHex(unsigned.txId)).toBe(txid);
      expect(bytesToHex(unsigned.owner.bytes)).toBe(owner);
    },
  );

  it("refuses a record that is not a Tron request", () => {
    const [first] = CASES;
    if (first === undefined) throw new Error("the fixture has no case");
    expect(() =>
      signBidirectionalEventToUnsignedTronTransaction(
        { ...first.request, txParamType: TxParamType.evmType2 },
        FIXTURE.rootPublicKey,
      ),
    ).toThrow(/expected a Tron request record/);
  });
});
