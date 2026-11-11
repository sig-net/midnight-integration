// The Tron signet e2e flow: the caller contract requests TriggerSmartContract
// calls against the SignetTronTarget Solidity contract on the local TRE, the
// MPC signs the transaction id (sha256 of the raw transaction it assembles
// from the request), THIS SUITE assembles the signed transaction and
// broadcasts it (the MPC never broadcasts), the fakenet watches the
// solidified receipt and posts a respond-bidirectional attestation, and the
// suite verifies that attestation against the pinned MPC response key and
// in-circuit.
//
// A Tron request carries an EMPTY output schema: the MPC refuses a Tron
// request whose output schema has any width, so no return data is ever
// attested and every outcome is attested over an empty output. What the
// flow covers is the verdict, one leg per outcome kind:
// - executed: isEven(6) runs, attested at its receipt's block.
// - failed: revertIf(true) reverts, attested at its receipt's block.
// - unviable: an isEven(7) request whose window closes one slot after its
//   reference block is signed and never broadcast. Once the solidified
//   chain passes its expiration the fakenet attests it unviable at the first
//   solidified block at or past the expiration (the suite finds that block
//   independently).
// verifyTronResponse settles all three at width 0 and records the verdict.
//
// TRE produces a block only when a transaction arrives, so every wait on a
// solidified receipt or an expiry runs inside withTronBlockPusher. Tests
// run in source order and feed each other through per-leg state. The file
// is self-sufficient (its own idempotent initialise stage), so it does not
// depend on the other flow files having run first. Every run submits fresh
// requests (each carries a fresh TaPoS window), so there is no request-id
// resume: a rerun against a kept caller simply adds new requests.

import type { TronTxWindow } from "@midnight-integration/test-caller-contract";
import {
  asciiPadded,
  boolAbiWord,
  buildTronRawTransaction,
  bytesToHex,
  calculateAttestedOutputHash,
  calculateRequestId,
  deriveTronAddress,
  MpcOutputCacheReader,
  OutputKind,
  parseSecp256k1PublicKey,
  requestIdBytes,
  type RequestIdHex,
  requestIdHex,
  type RespondBidirectionalEvent,
  respondBidirectionalEventToCircuitInput,
  SIGNET_DEFAULT_KEY_VERSION,
  TRON_CAIP2_ID,
  tronAddressFromBase58,
  tronTransactionId,
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
  tronTxWindowFromBlock,
  waitForFreshTronHead,
} from "../src/local-tron.ts";
import { fetchAttestedOutput, mpcOutputCacheUrl } from "../src/mpc-output-cache.ts";
import { banner } from "../src/output.ts";
import { pollUntilDefined } from "../src/poll.ts";
import { pollSignetNotification } from "../src/signet-notifications.ts";
import { withTronBlockPusher } from "../src/tron-block-pusher.ts";

const MINUTE = 60_000;

/** The setup-populated env accumulator (see the base flow file). */
const env = injectE2eEnv();

/** Assert a setup step populated `name`, failing with a pointed message. */
const requireEnv = (name: string): string => requireEnvOf(env, name);

// Wallet facade + caller context + MPC-style readers shared by every test in
// this file (lazily built, so the offline path never touches the network).
// Stopped once in afterAll.
const session = createCallerE2eSession(env);

/** The caller's Tron request map's ledger field (named in the notification). */
const TRON_REQUESTS_INDEX_FIELD = 9;

/** Every outcome of a Tron request is attested over an EMPTY output. */
const EMPTY_OUTPUT = new Uint8Array(0);

/** The energy fee ceiling every Tron request carries: 50 TRX, in sun. */
const TRON_FEE_LIMIT_SUN = 50_000_000n;

/**
 * The validity window of a request the suite broadcasts: one hour, ample
 * for the Midnight prove and the MPC's signature (java-tron accepts up to
 * 24 hours ahead of the head block).
 */
const BROADCAST_VALIDITY_MS = 60n * 60_000n;

/**
 * The validity window of the request that must expire unexecuted: one
 * 3-second Tron slot, closed long before its signature arrives.
 */
const EXPIRING_VALIDITY_MS = 3_000n;

/** The canonical uint256 ABI word of `value`. */
const uint256Word = (value: bigint): Uint8Array => getBytes(toBeHex(value, 32));

/**
 * One Tron leg's configuration: the target method, the request's window
 * and the verdict the MPC must reach.
 */
interface TronLegCase {
  /** Labels the test stages. */
  name: string;
  /** The Solidity signature the selector derives from, e.g. "isEven(uint256)". */
  signature: string;
  /** The argument as the caller must store it: one canonical ABI word. */
  argWord: Uint8Array;
  /** The argument as the banner prints it. */
  argLabel: string;
  /**
   * The verdict the MPC must attest: executed and failed are broadcast and
   * reach a receipt, unviable is never broadcast and expires.
   */
  outcome: OutputKind;
  /** Milliseconds from the request's timestamp to its expiration. */
  validityMs: bigint;
  /** Drive the leg's submit circuit. */
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
    // The Boolean is composed into its ABI word in-circuit (boolAbiWord).
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

/** The receipt result each broadcast verdict requires. */
const RECEIPT_RESULT: Partial<Record<OutputKind, string>> = {
  [OutputKind.executed]: "SUCCESS",
  [OutputKind.failed]: "REVERT",
};

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("signet-caller Tron e2e", () => {
  installFlowHooks();

  afterAll(async () => {
    await session.stop();
  });

  // The derived Tron account is shared by every leg (all submit circuits
  // fix the same path bytes), resolved lazily once env is populated.
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
    // Per-leg state threaded through the ordered stages below.
    let requestId: RequestIdHex;
    let reference: TronBlockRef;
    let txWindow: TronTxWindow;
    let signedTransaction: Uint8Array | undefined;
    let txid: Uint8Array;
    // The block height the attestation must name: the receipt's block for
    // a broadcast leg, the expiry boundary for the expiring one.
    let expectedHeight: bigint;
    let attestedEvent: RespondBidirectionalEvent;

    it(
      `${leg.name} submit [signet-caller contract method call]: record the Tron request and pin it MPC-style`,
      async () => {
        const context = await session.callerContext();
        const rpc = tronRpcUrl(env);
        const targetBase58 = requireEnv("TRON_TARGET_CONTRACT_ADDRESS");
        const target = tronAddressFromBase58(targetBase58);

        // The TaPoS reference is a head block no older than a few slots: a
        // broadcast transaction's window counts from it, and the expiring
        // leg's window closes one slot after it.
        reference = await withTronBlockPusher(rpc, () => waitForFreshTronHead(rpc, 10_000, MINUTE));
        txWindow = tronTxWindowFromBlock(reference, leg.validityMs, TRON_FEE_LIMIT_SUN);

        const before = await readCallerRequestIds(context, "tronSignBidirectionalEventMap");
        await leg.submit(context, target, txWindow);

        // State indexing lags finalization: poll briefly for the fresh id.
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

        // MPC-convention verification: fetch the record the way the response
        // server does and pin the caller-supplied window and target, the
        // in-circuit selector literal (against its ethers derivation), the
        // empty schemas and the request-id TS twin.
        const record = await session
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
        expect(record.executionDest).toEqual(asciiPadded(TRON_CAIP2_ID, 64));
        // Empty: the MPC refuses a Tron request whose output schema has any width.
        expect(record.outputDeserializationSchema).toEqual(EMPTY_OUTPUT);
        expect(record.respondSerializationSchema).toEqual(EMPTY_OUTPUT);
        expect(requestId).toBe(requestIdHex(calculateRequestId(record)));

        // The transaction id the MPC signs: sha256 of the raw transaction
        // owned by the derived account.
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
        // getSignedTronTransaction attaches only a response that verifies
        // against the derived account over this request's transaction id.
        signedTransaction = await pollUntilDefined(
          () => reader.getSignedTronTransaction(requestId, derivedAccount().base58),
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
          const receipt = await withTronBlockPusher(rpc, () =>
            broadcastSignedTronTransaction(rpc, signed, txid, 3 * MINUTE),
          );
          expect(
            receipt.receipt?.result,
            "the execution result must match the leg's expected outcome",
          ).toBe(RECEIPT_RESULT[leg.outcome]);
          expectedHeight = BigInt(receipt.blockNumber);
          banner([
            `${leg.name} transaction solidified (${String(receipt.receipt?.result)}):`,
            "",
            `  txid:  ${bytesToHex(txid)}`,
            `  block: ${String(receipt.blockNumber)}`,
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
          // An oracle independent of the attestation: scan the solidified
          // blocks after the reference for the first at or past the
          // expiration.
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
      `${leg.name} attestation: the fakenet attests the request ${OutputKind[leg.outcome]} over an empty output`,
      async () => {
        expect(requestId).toBeDefined();
        expect(expectedHeight).toBeDefined();
        const rpc = tronRpcUrl(env);
        const reader = session.responseReader(TRON_REQUESTS_INDEX_FIELD);
        const mpcResponseKey = parseSecp256k1PublicKey(requireEnv("MPC_RESPONSE_KEY"));
        // The fakenet reads only solidified data: keep blocks coming until it
        // has seen the receipt, or the chain has passed the expiration.
        const attested = await withTronBlockPusher(rpc, () =>
          pollUntilDefined(
            () =>
              reader.getVerifiedRespondBidirectionalEvent(requestId, EMPTY_OUTPUT, mpcResponseKey),
            5 * MINUTE,
            2000,
          ),
        );
        expect(attested, "a posted attestation must verify over the empty output").toBeDefined();
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
        expect(attested.serializedOutputLength, "the posted output width").toBe(0n);
        expect(attested.outputHash, "the posted output hash").toEqual(
          calculateAttestedOutputHash(EMPTY_OUTPUT),
        );
        const digest = calculateSignetAttestationDigest(
          requestIdBytes(requestId),
          attested.blockHeight,
          attested.outputKind,
          EMPTY_OUTPUT,
        );
        expect(attested.digest, "the posted digest must be the one recomputed here").toEqual(
          digest,
        );

        // Cache route: the fakenet cached exactly the empty output it attested.
        const outputCache = new MpcOutputCacheReader({
          cacheUrl: mpcOutputCacheUrl(env),
          networkId: getMidnightNodeConfig(env).networkId,
          signerContractAddress: requireEnv("MIDNIGHT_SIGNER_CONTRACT_ADDRESS"),
        });
        expect(await fetchAttestedOutput(outputCache, requestId)).toEqual(EMPTY_OUTPUT);

        banner([
          `${leg.name} attestation verifies over the empty output:`,
          "",
          `  kind:   ${OutputKind[attested.outputKind]} (posted by the MPC)`,
          `  height: ${String(attested.blockHeight)}`,
          `  digest: 0x${Buffer.from(digest).toString("hex")}`,
        ]);
      },
      10 * MINUTE,
    );

    it(
      `${leg.name} verify [signet-caller contract method call]: verifyTronResponse settles the attestation at width 0`,
      async () => {
        expect(attestedEvent).toBeDefined();
        const context = await session.callerContext();
        await verifyAndAwaitConsumption(context, "tronSignBidirectionalEventMap", requestId, () =>
          context.caller.callTx.verifyTronResponse(
            respondBidirectionalEventToCircuitInput(attestedEvent),
            EMPTY_OUTPUT,
          ),
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
        // Written by the verify circuit in the same transaction that
        // consumed the request.
        const verdict = (await readCallerLedger(context)).tronVerdicts.lookup(
          requestIdBytes(requestId),
        );
        expect(verdict).toBe(leg.outcome);
      },
      MINUTE,
    );
  }
});
