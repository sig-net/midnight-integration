import type { TronTxWindow } from "@midnight-integration/test-caller-contract";
import {
  asciiPadded,
  assembleCalldata,
  boolAbiWord,
  buildTronRawTransaction,
  bytesToHex,
  calculateAttestedOutputHash,
  calculateRequestId,
  deriveTronAddress,
  evmTraceOutputFromTronReceipt,
  executedEvmRespondOutput,
  isEvmContractCall,
  type JsonValue,
  MpcOutputCacheReader,
  OutputKind,
  parseSecp256k1PublicKey,
  pureCircuits,
  requestIdBytes,
  type RequestIdHex,
  requestIdHex,
  type RespondBidirectionalEvent,
  respondBidirectionalEventToCircuitInput,
  type SignBidirectionalEvent,
  SIGNET_DEFAULT_KEY_VERSION,
  tronAddressFromBase58,
  tronTransactionId,
  type TronTxParams,
  TxParamType,
} from "@sig-net/midnight";
import { calculateSignetAttestationDigest } from "@sig-net/midnight/testing";
import { getMidnightNodeConfig } from "@sig-net/midnight-contract-deploy";
import { getBytes, id as keccakId, toBeHex } from "ethers";
import { afterAll, describe, expect, it } from "vitest";

import {
  type CallerContext,
  createCallerE2eSession,
  ensureMpcResponseKeyStored,
  readCallerLedger,
  readCallerRequestIds,
  verifyAndAwaitConsumption,
} from "../src/caller-session.ts";
import { CALLER_PATH_HEX } from "../src/constants.ts";
import { requireEnv as requireEnvOf } from "../src/e2e-env.ts";
import { injectE2eEnv, installFlowHooks } from "../src/flow-hooks.ts";
import {
  broadcastSignedTronTransaction,
  findSolidifiedExpiryBoundary,
  getSolidifiedTransactionInfo,
  getSolidifiedTronHeadBlock,
  type TronBlockRef,
  tronRpcUrl,
  type TronTransactionInfo,
  tronTxWindowFromBlock,
  waitForFreshTronHead,
} from "../src/local-tron.ts";
import { fetchAttestedOutput, mpcOutputCacheUrl } from "../src/mpc-output-cache.ts";
import { banner } from "../src/output.ts";
import { pollUntilDefined } from "../src/poll.ts";
import { pollSignetNotification } from "../src/signet-notifications.ts";
import { withTronBlockPusher } from "../src/tron-block-pusher.ts";

const MINUTE = 60_000;

const env = injectE2eEnv();

const requireEnv = (name: string): string => requireEnvOf(env, name);

const session = createCallerE2eSession(env);

const TRON_REQUESTS_INDEX_FIELD = 9;

const EMPTY_OUTPUT = new Uint8Array(0);

const BOOL_OUTPUT_SCHEMA = asciiPadded('[{"name":"success","type":"bool"}]', 34);

const TRON_FEE_LIMIT_SUN = 50_000_000n;

const BROADCAST_VALIDITY_MS = 60n * 60_000n;

const EXPIRING_VALIDITY_MS = 3_000n;

const uint256Word = (value: bigint): Uint8Array => getBytes(toBeHex(value, 32));

interface TronLegCase {
  name: string;
  signature: string;
  argWord: Uint8Array;
  argLabel: string;
  outcome: OutputKind;
  validityMs: bigint;
  submit(context: CallerContext, target: Uint8Array, txWindow: TronTxWindow): Promise<unknown>;
}

const LEGS: TronLegCase[] = [
  {
    name: "isEven",
    signature: "isEven(uint256)",
    argWord: uint256Word(6n),
    argLabel: "6",
    outcome: OutputKind.executed,
    validityMs: BROADCAST_VALIDITY_MS,
    submit: (context, target, txWindow) =>
      context.caller.callTx.submitTronIsEvenRequest(
        SIGNET_DEFAULT_KEY_VERSION,
        target,
        uint256Word(6n),
        txWindow,
      ),
  },
  {
    name: "revertIf",
    signature: "revertIf(bool)",
    argWord: boolAbiWord(true),
    argLabel: "true",
    outcome: OutputKind.failed,
    validityMs: BROADCAST_VALIDITY_MS,
    submit: (context, target, txWindow) =>
      context.caller.callTx.submitTronRevertIfRequest(
        SIGNET_DEFAULT_KEY_VERSION,
        target,
        true,
        txWindow,
      ),
  },
  {
    name: "expired isEven",
    signature: "isEven(uint256)",
    argWord: uint256Word(7n),
    argLabel: "7 (never broadcast)",
    outcome: OutputKind.unviable,
    validityMs: EXPIRING_VALIDITY_MS,
    submit: (context, target, txWindow) =>
      context.caller.callTx.submitTronIsEvenRequest(
        SIGNET_DEFAULT_KEY_VERSION,
        target,
        uint256Word(7n),
        txWindow,
      ),
  },
];

const RECEIPT_RESULT: Partial<Record<OutputKind, string>> = {
  [OutputKind.executed]: "SUCCESS",
  [OutputKind.failed]: "REVERT",
};

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("signet-caller Tron e2e", () => {
  installFlowHooks();

  afterAll(async () => {
    await session.stop();
  });

  const derivedAccount = () =>
    deriveTronAddress(
      requireEnv("MPC_SECP256K1_PUBKEY"),
      requireEnv("MIDNIGHT_CALLER_CONTRACT_ADDRESS"),
      CALLER_PATH_HEX,
    );

  it(
    "initialise [signet-caller contract method call]: the MPC response key is stored (idempotent)",
    async () => {
      const context = await session.callerContext();
      const mpcResponseKey = parseSecp256k1PublicKey(requireEnv("MPC_RESPONSE_KEY"));
      const outcome = await ensureMpcResponseKeyStored(context, mpcResponseKey);
      expect(outcome).toMatch(/^(stored|already-stored)$/);
    },
    15 * MINUTE,
  );

  for (const leg of LEGS) {
    const broadcasts = leg.outcome !== OutputKind.unviable;
    let requestId: RequestIdHex;
    let record: SignBidirectionalEvent<TronTxParams>;
    let receipt: TronTransactionInfo | undefined;
    let expectedOutput: Uint8Array;
    let reference: TronBlockRef;
    let txWindow: TronTxWindow;
    let signedTransaction: Uint8Array | undefined;
    let txid: Uint8Array;
    let expectedHeight: bigint;
    let attestedEvent: RespondBidirectionalEvent;

    it(
      `${leg.name} submit [signet-caller contract method call]: record the Tron request and pin it MPC-style`,
      async () => {
        const context = await session.callerContext();
        const rpc = tronRpcUrl(env);
        const targetBase58 = requireEnv("TRON_TARGET_CONTRACT_ADDRESS");
        const target = tronAddressFromBase58(targetBase58);

        reference = await withTronBlockPusher(rpc, () => waitForFreshTronHead(rpc, 10_000, MINUTE));
        txWindow = tronTxWindowFromBlock(reference, leg.validityMs, TRON_FEE_LIMIT_SUN);

        const before = await readCallerRequestIds(context, "tronSignBidirectionalEventMap");
        await leg.submit(context, target, txWindow);

        const fresh = await pollUntilDefined(
          async () => {
            const added = [
              ...(await readCallerRequestIds(context, "tronSignBidirectionalEventMap")),
            ].filter((entry) => !before.has(entry));
            return added.length === 0 ? undefined : added;
          },
          MINUTE,
          1000,
        );
        expect(fresh, "the submit must add exactly one request to the Tron map").toHaveLength(1);
        const [firstFresh] = fresh ?? [];
        if (firstFresh === undefined) {
          throw new Error("the length assertion above proves this is unreachable");
        }
        requestId = firstFresh;

        record = await session
          .responseReader(TRON_REQUESTS_INDEX_FIELD)
          .getTronSignatureRequest(requestId);
        expect(record.txParamType).toBe(TxParamType.tron);
        expect(record.txParams).toEqual({
          ...txWindow,
          contractAddress: target,
          callValue: 0n,
          calldata: {
            is_some: true,
            value: {
              selector: getBytes(keccakId(leg.signature).slice(0, 10)),
              noWords: 1n,
              words: [leg.argWord],
            },
          },
        });
        expect(record.executionDest).toEqual(pureCircuits.tronCaip2Id());
        expect(record.outputDeserializationSchema).toEqual(BOOL_OUTPUT_SCHEMA);
        expect(record.respondSerializationSchema).toEqual(EMPTY_OUTPUT);
        expect(requestId).toBe(requestIdHex(calculateRequestId(record)));

        txid = tronTransactionId(buildTronRawTransaction(record.txParams, derivedAccount().bytes));

        banner([
          `${leg.name} Tron request recorded on the caller ledger (map field ${String(TRON_REQUESTS_INDEX_FIELD)}):`,
          "",
          `  request id: ${requestId}`,
          `  txid:       ${bytesToHex(txid)}`,
          `  target:     ${targetBase58}`,
          `  argument:   ${leg.argLabel}`,
          `  reference:  block ${String(reference.number)} at ${String(reference.timestamp)}`,
          `  expiration: ${String(txWindow.expiration)}`,
        ]);
      },
      15 * MINUTE,
    );

    it(
      `${leg.name} notification: emitted on the signet signer naming field ${String(TRON_REQUESTS_INDEX_FIELD)}`,
      async () => {
        expect(requestId).toBeDefined();
        const decoded = await pollSignetNotification({
          env,
          callerAddress: requireEnv("MIDNIGHT_CALLER_CONTRACT_ADDRESS"),
          requestsPath: [TRON_REQUESTS_INDEX_FIELD],
          requestId,
          description: `declaring request ${requestId} for the caller at path [${String(TRON_REQUESTS_INDEX_FIELD)}]`,
        });
        expect(decoded.version).toBe(1);
        expect(decoded.requestsPath).toEqual([TRON_REQUESTS_INDEX_FIELD]);
      },
      2 * MINUTE,
    );

    it(
      `${leg.name} pollSignatureResponse: the MPC's signature over the txid recovers to the derived Tron account`,
      async () => {
        expect(requestId).toBeDefined();
        const reader = session.responseReader(TRON_REQUESTS_INDEX_FIELD);
        signedTransaction = await pollUntilDefined(
          () => reader.getSignedTronTransaction(requestId, requireEnv("MPC_SECP256K1_PUBKEY")),
          3 * MINUTE,
          1000,
        );
        if (signedTransaction === undefined) {
          throw new Error(
            `timed out waiting for a valid signature response to request ${requestId}`,
          );
        }
      },
      5 * MINUTE,
    );

    if (broadcasts) {
      it(
        `${leg.name} broadcast: the signed transaction solidifies on the local TRE with result ${String(RECEIPT_RESULT[leg.outcome])}`,
        async () => {
          if (signedTransaction === undefined) {
            throw new Error(`no signed transaction for request ${requestId}`);
          }
          const signed = signedTransaction;
          const rpc = tronRpcUrl(env);
          const solidified = await withTronBlockPusher(rpc, () =>
            broadcastSignedTronTransaction(rpc, signed, txid, 3 * MINUTE),
          );
          receipt = solidified;
          expect(
            solidified.receipt?.result,
            "the execution result must match the leg's expected outcome",
          ).toBe(RECEIPT_RESULT[leg.outcome]);
          expectedHeight = BigInt(solidified.blockNumber);
          banner([
            `${leg.name} transaction solidified (${String(solidified.receipt?.result)}):`,
            "",
            `  txid:  ${bytesToHex(txid)}`,
            `  block: ${String(solidified.blockNumber)}`,
          ]);
        },
        5 * MINUTE,
      );
    } else {
      it(
        `${leg.name} expiry: the solidified chain passes the expiration and the transaction was never included`,
        async () => {
          expect(requestId).toBeDefined();
          const rpc = tronRpcUrl(env);
          const passed = await withTronBlockPusher(rpc, () =>
            pollUntilDefined(
              async () =>
                (await getSolidifiedTronHeadBlock(rpc)).timestamp >= txWindow.expiration
                  ? true
                  : undefined,
              3 * MINUTE,
              1000,
            ),
          );
          expect(passed, "the solidified head must reach the expiration").toBe(true);
          expect(
            await getSolidifiedTransactionInfo(rpc, txid),
            "the expired transaction has no receipt",
          ).toBeUndefined();
          expectedHeight = await findSolidifiedExpiryBoundary(
            rpc,
            reference.number,
            txWindow.expiration,
          );
          banner([
            `${leg.name} transaction expired unincluded:`,
            "",
            `  txid:     ${bytesToHex(txid)}`,
            `  boundary: block ${String(expectedHeight)} (first solidified block at or past ${String(txWindow.expiration)})`,
          ]);
        },
        5 * MINUTE,
      );
    }

    it(
      `${leg.name} attestation: the fakenet attests the request ${OutputKind[leg.outcome]} over the output rebuilt from the receipt`,
      async () => {
        expect(requestId).toBeDefined();
        expect(expectedHeight).toBeDefined();
        if (leg.outcome === OutputKind.executed) {
          if (receipt === undefined) {
            throw new Error(`no solidified receipt for request ${requestId}`);
          }
          expectedOutput = executedEvmRespondOutput(
            record.outputDeserializationSchema,
            isEvmContractCall(assembleCalldata(record.txParams.calldata)),
            evmTraceOutputFromTronReceipt(receipt as unknown as JsonValue),
          );
        } else {
          expectedOutput = EMPTY_OUTPUT;
        }
        expect(
          expectedOutput,
          "isEven(6) returns true, one byte 0x01; a failure carries no output",
        ).toEqual(leg.outcome === OutputKind.executed ? Uint8Array.of(1) : EMPTY_OUTPUT);
        const rpc = tronRpcUrl(env);
        const reader = session.responseReader(TRON_REQUESTS_INDEX_FIELD);
        const mpcResponseKey = parseSecp256k1PublicKey(requireEnv("MPC_RESPONSE_KEY"));
        const attested = await withTronBlockPusher(rpc, () =>
          pollUntilDefined(
            () =>
              reader.getVerifiedRespondBidirectionalEvent(
                requestId,
                expectedOutput,
                mpcResponseKey,
              ),
            5 * MINUTE,
            2000,
          ),
        );
        expect(attested, "a posted attestation must verify over the expected output").toBeDefined();
        if (attested === undefined) {
          throw new Error("the toBeDefined assertion above proves this is unreachable");
        }
        attestedEvent = attested;
        expect(attested.outputKind, "the attested kind must be the leg's expected verdict").toBe(
          leg.outcome,
        );

        expect(
          attested.blockHeight,
          "the attested height: the receipt's block, or the expiry boundary",
        ).toBe(expectedHeight);
        expect(attested.serializedOutputLength, "the posted output width").toBe(
          BigInt(expectedOutput.length),
        );
        expect(attested.outputHash, "the posted output hash").toEqual(
          calculateAttestedOutputHash(expectedOutput),
        );
        const digest = calculateSignetAttestationDigest(
          requestIdBytes(requestId),
          attested.blockHeight,
          attested.outputKind,
          expectedOutput,
        );
        expect(attested.digest, "the posted digest must be the one recomputed here").toEqual(
          digest,
        );

        const outputCache = new MpcOutputCacheReader({
          cacheUrl: mpcOutputCacheUrl(env),
          networkId: getMidnightNodeConfig(env).networkId,
          signerContractAddress: requireEnv("MIDNIGHT_SIGNER_CONTRACT_ADDRESS"),
        });
        expect(await fetchAttestedOutput(outputCache, requestId)).toEqual(expectedOutput);

        banner([
          `${leg.name} attestation verifies over the output 0x${Buffer.from(expectedOutput).toString("hex")}:`,
          "",
          `  kind:   ${OutputKind[attested.outputKind]} (posted by the MPC)`,
          `  height: ${String(attested.blockHeight)}`,
          `  digest: 0x${Buffer.from(digest).toString("hex")}`,
        ]);
      },
      10 * MINUTE,
    );

    it(
      `${leg.name} verify [signet-caller contract method call]: ${leg.outcome === OutputKind.executed ? "verifyTronResponse settles the attested true at width 1" : "verifyTronFailureResponse settles the attestation at width 0"}`,
      async () => {
        expect(attestedEvent).toBeDefined();
        const context = await session.callerContext();
        const event = respondBidirectionalEventToCircuitInput(attestedEvent);
        await verifyAndAwaitConsumption(context, "tronSignBidirectionalEventMap", requestId, () =>
          leg.outcome === OutputKind.executed
            ? context.caller.callTx.verifyTronResponse(event, expectedOutput)
            : context.caller.callTx.verifyTronFailureResponse(event, EMPTY_OUTPUT),
        );
        banner([`${leg.name} request ${requestId} verified in-circuit and consumed.`]);
      },
      15 * MINUTE,
    );

    it(
      `${leg.name} settlement: the ledger records the MPC's ${OutputKind[leg.outcome]} verdict`,
      async () => {
        expect(requestId).toBeDefined();
        const context = await session.callerContext();
        const verdict = (await readCallerLedger(context)).tronVerdicts.lookup(
          requestIdBytes(requestId),
        );
        expect(verdict).toBe(leg.outcome);
      },
      MINUTE,
    );
  }
});
