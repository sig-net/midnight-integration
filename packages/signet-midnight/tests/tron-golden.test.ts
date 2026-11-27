import { readFileSync } from "node:fs";

import type { AlignedValue } from "@midnight-ntwrk/compact-runtime";
import { compactDeserialize } from "@sig-net/midnight-serde";
import { recoverAddress } from "ethers";
import { describe, expect, it } from "vitest";

import {
  calculateSignetAttestationDigest,
  signatureRespondedEventToSignature,
} from "../src/ecdsa-attestation.ts";
import {
  assembleCalldata,
  buildSignedTronTransaction,
  buildTronRawTransaction,
  bytesToHex,
  calculateAttestedOutputHash,
  calculateRequestId,
  calculateTronTriggerSmartContractTxParamsDigest,
  canonicalSchemaText,
  decodeTronTriggerSmartContractSignBidirectionalEvent,
  deriveRespondSchema,
  deriveSignBidirectionalEventSignerTronAddress,
  deserializeEvmOutput,
  evmTraceOutputFromTronReceipt,
  executedEvmRespondOutput,
  hexToBytes,
  isEvmContractCall,
  type JsonValue,
  OutputKind,
  parseRequestIdHex,
  requestIdBytes,
  type SignatureRespondedEvent,
  type SignBidirectionalEvent,
  tronAddressFromEvm,
  tronAddressToBase58,
  tronSignBidirectionalEventDescriptor,
  tronTransactionId,
  type TronTriggerSmartContractTxParams,
  TxParamType,
} from "../src/index.ts";
import { ecdsaSignatureToMpcSignature } from "../src/testing.ts";

interface TronTriggerSmartContractTxParamsJson {
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
  params?: TronTriggerSmartContractTxParamsJson;
  owner: string;
  ownerBase58: string;
  raw: string;
  txid: string;
  signature?: SignatureJson;
  signed?: string;
}

interface RespondVectorJson {
  name: string;
  receipt: JsonValue & { contractResult?: string[] };
  blockHeight: number;
  outcome: "executed" | "failed" | "extractionFailed";
  output?: string;
  attestedOutputHash?: string;
  attestationDigest?: string;
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
      txParams: TronTriggerSmartContractTxParamsJson;
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
  respondRequest: {
    requestId: string;
    serializedTransaction: string;
    outputDeserializationSchema: string;
    respondSerializationSchema: string;
    caip2Id: string;
    owner: string;
    mpcRootPublicKey: string;
  };
  respond: RespondVectorJson[];
}

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/tron-golden-mpc-3d586f30.json", import.meta.url), "utf8"),
) as TronGoldenFixture;

const tronTriggerSmartContractTxParamsOf = (
  json: TronTriggerSmartContractTxParamsJson,
): TronTriggerSmartContractTxParams => ({
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
    txParamType: TxParamType.tronTriggerSmartContract,
    txParams: tronTriggerSmartContractTxParamsOf(record.txParams),
    executionDest: hexToBytes(record.executionDest),
    signatureDest: record.signatureDest,
    params: hexToBytes(record.params),
    outputDeserializationSchema: hexToBytes(record.outputDeserializationSchema),
    respondSerializationSchema: hexToBytes(record.respondSerializationSchema),
  } satisfies SignBidirectionalEvent<TronTriggerSmartContractTxParams>,
  txParamsDigest,
  requestId,
}));

const ASSEMBLED = [...FIXTURE.transactions, ...FIXTURE.mainnetUsdt].flatMap(
  ({ name, params, owner, raw, txid }) =>
    params === undefined
      ? []
      : [{ name, params: tronTriggerSmartContractTxParamsOf(params), owner, raw, txid }],
);

const SIGNED = [...FIXTURE.transactions, ...FIXTURE.mainnetUsdt].flatMap(
  ({ name, raw, signature, signed }) =>
    signature === undefined || signed === undefined ? [] : [{ name, raw, signature, signed }],
);

const REAL_SIGNATURES = [
  ...FIXTURE.transactions.filter(({ name }) => name.startsWith("probe request signed by the MPC")),
  ...FIXTURE.mainnetUsdt,
].flatMap(({ name, params, owner, ownerBase58, signature }) =>
  params === undefined || signature === undefined
    ? []
    : [{ name, params: tronTriggerSmartContractTxParamsOf(params), owner, ownerBase58, signature }],
);

const BOOL_SCHEMA = canonicalSchemaText([{ name: "success", type: "bool" }]);

const TEST_CALLER_RECORD = REQUESTS.find(({ name }) =>
  name.includes("the compiled test-caller record"),
)?.record;

const RESPOND = FIXTURE.respond.map((vector) => ({
  ...vector,
  outputKind: vector.outcome === "failed" ? OutputKind.failed : OutputKind.executed,
}));

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
    expect(FIXTURE.mpcCommit).toBe("3d586f30c0784155d0e9393b1500f1ca2ca6318d");
  });

  it("carries the bool output schema on every record but the MPC's pinned empty-schema one", () => {
    expect(BOOL_SCHEMA).toBe('[{"name":"success","type":"bool"}]');
    expect(new TextEncoder().encode(BOOL_SCHEMA)).toHaveLength(34);
    expect(
      REQUESTS.map(({ record }) => new TextDecoder().decode(record.outputDeserializationSchema)),
    ).toEqual(["", BOOL_SCHEMA, BOOL_SCHEMA, BOOL_SCHEMA]);
    expect(REQUESTS.map(({ record }) => record.respondSerializationSchema.length)).toEqual([
      0, 0, 0, 0,
    ]);
    expect(REQUESTS[0]?.txParamsDigest).toBe(
      "e387f99d546a394b96180956656c7800aae76b96ba459ed87919656a34d33400",
    );
    expect(REQUESTS[0]?.requestId).toBe(
      "e74c66064dc639e473b095dfcf76eba53297df9b580868b14c382e0e2a901a00",
    );
  });

  it.each(REQUESTS)(
    "D_tron and the request id of $name",
    ({ record, txParamsDigest, requestId }) => {
      expect(bytesToHex(calculateTronTriggerSmartContractTxParamsDigest(record.txParams))).toBe(
        txParamsDigest,
      );
      expect(bytesToHex(calculateRequestId(record))).toBe(requestId);
    },
  );

  it("decodes the compiled test-caller record cell to its record and id", () => {
    const descriptor = tronSignBidirectionalEventDescriptor(1, 34, 0);
    const cell: AlignedValue = {
      value: FIXTURE.compiledCell.atoms.map(hexToBytes),
      alignment: descriptor.alignment(),
    };
    expect(cell.alignment.map((segment) => segment.tag === "atom" && segment.value)).toEqual(
      FIXTURE.compiledCell.widths.map((length) => ({ tag: "bytes", length })),
    );
    const decoded = decodeTronTriggerSmartContractSignBidirectionalEvent(
      cell,
      "compiled probe record",
    );
    expect(decoded).toEqual(TEST_CALLER_RECORD);
    expect(descriptor.toValue(decoded).map(bytesToHex)).toEqual(FIXTURE.compiledCell.atoms);
    expect(bytesToHex(calculateRequestId(decoded))).toBe(FIXTURE.compiledCell.requestId);
    expect(FIXTURE.compiledCell.requestId).toBe(
      "e74c66064dc639e473b095dfcf76eba53297df9b580868b14c382e0e2a901a00",
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
    "a real signature recovers to its owner over the assembled id: $name",
    ({ params, owner, ownerBase58, signature }) => {
      const txid = tronTransactionId(buildTronRawTransaction(params, hexToBytes(owner)));
      const signer = recoverAddress(
        txid,
        signatureRespondedEventToSignature(responseOf(signature)),
      );
      expect(tronAddressToBase58(tronAddressFromEvm(signer))).toBe(ownerBase58);
    },
  );

  it("assembles the MPC's transaction for the test-caller record from its derived owner", () => {
    const request = FIXTURE.respondRequest;
    if (TEST_CALLER_RECORD === undefined) throw new Error("no test-caller record");
    const owner = deriveSignBidirectionalEventSignerTronAddress(
      request.mpcRootPublicKey,
      TEST_CALLER_RECORD,
    );
    expect(bytesToHex(owner.bytes)).toBe(request.owner);
    expect(bytesToHex(buildTronRawTransaction(TEST_CALLER_RECORD.txParams, owner.bytes))).toBe(
      request.serializedTransaction,
    );
    expect(bytesToHex(calculateRequestId(TEST_CALLER_RECORD))).toBe(request.requestId);
    expect(request.outputDeserializationSchema).toBe(
      bytesToHex(TEST_CALLER_RECORD.outputDeserializationSchema),
    );
    expect(request.respondSerializationSchema).toBe("");
    expect(request.caip2Id).toBe("tron:mainnet");
  });

  it("covers a true, a false, a reverted and an unreadable receipt", () => {
    expect(RESPOND.map(({ outcome, output }) => [outcome, output])).toEqual([
      ["executed", "00"],
      ["executed", "01"],
      ["failed", ""],
      ["extractionFailed", undefined],
    ]);
  });

  it.each(RESPOND.filter(({ outcome }) => outcome === "executed"))(
    "recovers the attested output from the receipt: $name",
    ({ receipt, output }) => {
      if (TEST_CALLER_RECORD === undefined) throw new Error("no test-caller record");
      const schema = TEST_CALLER_RECORD.outputDeserializationSchema;
      const isContractCall = isEvmContractCall(
        assembleCalldata(TEST_CALLER_RECORD.txParams.calldata),
      );
      const recovered = executedEvmRespondOutput(
        schema,
        isContractCall,
        evmTraceOutputFromTronReceipt(receipt),
      );
      expect(bytesToHex(recovered)).toBe(output);
      const returnData = receipt.contractResult?.[0] ?? "";
      const success = BigInt(`0x${returnData}`) === 1n;
      expect(deserializeEvmOutput(schema, `0x${returnData}`)).toEqual({ success });
      expect(compactDeserialize(deriveRespondSchema(schema), recovered)).toEqual({ success });
    },
  );

  it.each(RESPOND.filter(({ outcome }) => outcome === "failed"))(
    "refuses an executed output for a failed receipt: $name",
    ({ receipt }) => {
      expect(() => evmTraceOutputFromTronReceipt(receipt)).toThrow(/reports the call failed/);
    },
  );

  it.each(RESPOND.filter(({ outcome }) => outcome === "extractionFailed"))(
    "refuses an output the MPC parks: $name",
    ({ receipt }) => {
      if (TEST_CALLER_RECORD === undefined) throw new Error("no test-caller record");
      expect(() =>
        executedEvmRespondOutput(
          TEST_CALLER_RECORD.outputDeserializationSchema,
          isEvmContractCall(assembleCalldata(TEST_CALLER_RECORD.txParams.calldata)),
          evmTraceOutputFromTronReceipt(receipt),
        ),
      ).toThrow(/returned no data/);
    },
  );

  it.each(RESPOND.filter(({ outcome }) => outcome !== "extractionFailed"))(
    "hashes the attested output and the attestation digest: $name",
    ({ blockHeight, output, outputKind, attestedOutputHash, attestationDigest }) => {
      const bytes = hexToBytes(output ?? "");
      expect(bytesToHex(calculateAttestedOutputHash(bytes))).toBe(attestedOutputHash);
      expect(
        bytesToHex(
          calculateSignetAttestationDigest(
            requestIdBytes(parseRequestIdHex(FIXTURE.respondRequest.requestId)),
            BigInt(blockHeight),
            outputKind,
            bytes,
          ),
        ),
      ).toBe(attestationDigest);
    },
  );
});
