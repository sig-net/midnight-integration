import { readFileSync } from "node:fs";

import type { AlignedValue } from "@midnight-ntwrk/compact-runtime";
import { describe, expect, it } from "vitest";

import {
  buildSignedTronTransaction,
  buildTronRawTransaction,
  bytesToHex,
  calculateRequestId,
  calculateTronTxParamsDigest,
  decodeTronSignBidirectionalEvent,
  hexToBytes,
  type SignatureRespondedEvent,
  type SignBidirectionalEvent,
  tronAddressToBase58,
  tronSignBidirectionalEventDescriptor,
  tronTransactionId,
  type TronTxParams,
  TxParamType,
  verifyTronSignatureRespondedEvent,
} from "../src/index.ts";
import { ecdsaSignatureToMpcSignature } from "../src/testing.ts";

interface TronTxParamsJson {
  refBlockBytes: string;
  refBlockHash: string;
  timestamp: string;
  expiration: string;
  feeLimit: string;
  contractAddress: string;
  callValue: string;
  calldata: { isSome: boolean; selector: string; noWords: number; words: string[] };
}

interface SignatureJson {
  r: string;
  s: string;
  v: number;
}

interface TransactionJson {
  name: string;
  params?: TronTxParamsJson;
  owner: string;
  ownerBase58: string;
  raw: string;
  txid: string;
  signature?: SignatureJson;
  signed?: string;
}

interface TronGoldenFixture {
  mpcCommit: string;
  requests: {
    name: string;
    record: {
      keyVersion: number;
      sender: string;
      path: string;
      algo: number;
      txParams: TronTxParamsJson;
      executionDest: string;
      signatureDest: number;
      params: string;
      outputDeserializationSchema: string;
      respondSerializationSchema: string;
    };
    txParamsDigest: string;
    requestId: string;
  }[];
  compiledCell: { atoms: string[]; widths: number[]; requestId: string };
  transactions: TransactionJson[];
  mainnetUsdt: TransactionJson[];
}

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/tron-golden-mpc-40f76c3.json", import.meta.url), "utf8"),
) as TronGoldenFixture;

const tronTxParamsOf = (json: TronTxParamsJson): TronTxParams => ({
  refBlockBytes: hexToBytes(json.refBlockBytes),
  refBlockHash: hexToBytes(json.refBlockHash),
  timestamp: BigInt(json.timestamp),
  expiration: BigInt(json.expiration),
  feeLimit: BigInt(json.feeLimit),
  contractAddress: hexToBytes(json.contractAddress),
  callValue: BigInt(json.callValue),
  calldata: {
    is_some: json.calldata.isSome,
    value: {
      selector: hexToBytes(json.calldata.selector),
      noWords: BigInt(json.calldata.noWords),
      words: json.calldata.words.map(hexToBytes),
    },
  },
});

const REQUESTS = FIXTURE.requests.map(({ name, record, txParamsDigest, requestId }) => ({
  name,
  record: {
    keyVersion: BigInt(record.keyVersion),
    sender: { bytes: hexToBytes(record.sender) },
    path: hexToBytes(record.path),
    algo: record.algo,
    txParamType: TxParamType.tron,
    txParams: tronTxParamsOf(record.txParams),
    executionDest: hexToBytes(record.executionDest),
    signatureDest: record.signatureDest,
    params: hexToBytes(record.params),
    outputDeserializationSchema: hexToBytes(record.outputDeserializationSchema),
    respondSerializationSchema: hexToBytes(record.respondSerializationSchema),
  } satisfies SignBidirectionalEvent<TronTxParams>,
  txParamsDigest,
  requestId,
}));

const ASSEMBLED = [...FIXTURE.transactions, ...FIXTURE.mainnetUsdt].flatMap(
  ({ name, params, owner, raw, txid }) =>
    params === undefined ? [] : [{ name, params: tronTxParamsOf(params), owner, raw, txid }],
);

const SIGNED = [...FIXTURE.transactions, ...FIXTURE.mainnetUsdt].flatMap(
  ({ name, raw, signature, signed }) =>
    signature === undefined || signed === undefined ? [] : [{ name, raw, signature, signed }],
);

const REAL_SIGNATURES = [
  ...FIXTURE.transactions.filter(({ name }) => name.startsWith("probe request signed by the MPC")),
  ...FIXTURE.mainnetUsdt,
].flatMap(({ name, params, ownerBase58, signature }) =>
  params === undefined || signature === undefined
    ? []
    : [{ name, params: tronTxParamsOf(params), ownerBase58, signature }],
);

const [SAMPLE_REQUEST] = REQUESTS;
if (SAMPLE_REQUEST === undefined) {
  throw new Error("the fixture holds no request vector");
}
const SAMPLE_RECORD = SAMPLE_REQUEST.record;

const responseOf = (signature: SignatureJson): SignatureRespondedEvent => ({
  requestId: new Uint8Array(32),
  signature: ecdsaSignatureToMpcSignature({
    r: BigInt(`0x${signature.r}`),
    s: BigInt(`0x${signature.s}`),
    recoveryId: signature.v,
  }),
});

describe(`Tron golden vectors (sig-net/mpc ${FIXTURE.mpcCommit})`, () => {
  it("names the MPC commit the vectors were generated at", () => {
    expect(FIXTURE.mpcCommit).toBe("40f76c3fb43bbcd12d258b6220f724e1155ed2b9");
  });

  it.each(REQUESTS)(
    "D_tron and the request id of $name",
    ({ record, txParamsDigest, requestId }) => {
      expect(bytesToHex(calculateTronTxParamsDigest(record.txParams))).toBe(txParamsDigest);
      expect(bytesToHex(calculateRequestId(record))).toBe(requestId);
    },
  );

  it("decodes the compiled probe record cell to the probe record and its id", () => {
    const probe = REQUESTS.find(({ requestId }) => requestId === FIXTURE.compiledCell.requestId);
    const descriptor = tronSignBidirectionalEventDescriptor(1, 0, 0);
    const cell: AlignedValue = {
      value: FIXTURE.compiledCell.atoms.map(hexToBytes),
      alignment: descriptor.alignment(),
    };
    expect(cell.alignment.map((segment) => segment.tag === "atom" && segment.value)).toEqual(
      FIXTURE.compiledCell.widths.map((length) => ({ tag: "bytes", length })),
    );
    const decoded = decodeTronSignBidirectionalEvent(cell, "compiled probe record");
    expect(decoded).toEqual(probe?.record);
    expect(descriptor.toValue(decoded).map(bytesToHex)).toEqual(FIXTURE.compiledCell.atoms);
    expect(bytesToHex(calculateRequestId(decoded))).toBe(FIXTURE.compiledCell.requestId);
    expect(FIXTURE.compiledCell.requestId).toBe(
      "b8425af03222be68e9ced2b7dcb384aa7de1dd6312be7aa6d631f57cdecbff00",
    );
  });

  it.each(ASSEMBLED)(
    "assembles the raw transaction and its id: $name",
    ({ params, owner, raw, txid }) => {
      const assembled = buildTronRawTransaction(params, hexToBytes(owner));
      expect(bytesToHex(assembled)).toBe(raw);
      expect(bytesToHex(tronTransactionId(assembled))).toBe(txid);
    },
  );

  it.each([...FIXTURE.transactions, ...FIXTURE.mainnetUsdt])(
    "renders the owner in base58 and hashes the raw bytes to the id: $name",
    ({ owner, ownerBase58, raw, txid }) => {
      expect(tronAddressToBase58(hexToBytes(owner))).toBe(ownerBase58);
      expect(bytesToHex(tronTransactionId(hexToBytes(raw)))).toBe(txid);
    },
  );

  it.each(SIGNED)("attaches the signature: $name", ({ raw, signature, signed }) => {
    expect(
      bytesToHex(buildSignedTronTransaction(hexToBytes(raw), responseOf(signature).signature)),
    ).toBe(signed);
  });

  it.each(REAL_SIGNATURES)(
    "a real signature verifies against its owner: $name",
    ({ params, ownerBase58, signature }) => {
      const request: SignBidirectionalEvent<TronTxParams> = { ...SAMPLE_RECORD, txParams: params };
      expect(verifyTronSignatureRespondedEvent(request, responseOf(signature), ownerBase58)).toBe(
        true,
      );
    },
  );
});
