// The REAL-EVM signet e2e flow: the caller contract requests calls against
// the SignetEvmTarget Solidity contract on the local anvil, the MPC signs,
// THIS SUITE broadcasts (the MPC only signs: broadcasting is a client
// responsibility), the fakenet observes the mined execution (via
// debug_traceTransaction, the same RPC method the real MPC uses) and posts
// a respond-bidirectional attestation. The suite then fetches the raw
// execution output from the fakenet's public /responses/{requestId} helper
// API (so clients need no debug_traceTransaction access of their own),
// recomputes the respond bytes (deserializeEvmOutput,
// serializeRespondOutput) and picks the attestation that VERIFIES over them
// against the pinned MPC response key before in-circuit verification. The
// fetched output is UNTRUSTED until that signature verification passes.
//
// One ordered pipeline per target method, driven by the METHODS config
// below: adding a Solidity method later means one Solidity function, one
// submit/verify circuit pair (a new exact-width request map when the schema
// width is new), and one METHODS entry. Tests run in source order and feed
// each other through per-method state. The file is self-sufficient (its own
// idempotent initialise stage), so it does not depend on the base EVM-free
// flow file having run first.
//
// The request-id envelope of the caller contract changed when the EVM
// circuits landed, so a MIDNIGHT_CALLER_CONTRACT_ADDRESS kept from an older
// deploy will fail: unset it (plus MPC_RESPONSE_KEY and any CALLER_*
// request-id resume vars) for one clean redeploy.

import {
  type AbiDecodedOutput,
  type AbiSchema,
  calculateRequestId,
  deriveEvmAddress,
  deserializeEvmOutput,
  hexToBytes,
  parseSecp256k1PublicKey,
  requestIdBytes,
  type RequestIdHex,
  requestIdHex,
  type RespondBidirectionalEvent,
  respondBidirectionalEventToCircuitInput,
  serializeRespondOutput,
  signBidirectionalEventToSignedEvmTransaction,
  SIGNET_DEFAULT_KEY_VERSION,
  stripHexPrefix,
} from "@sig-net/midnight";
import { calculateSignetAttestationDigest } from "@sig-net/midnight/testing";
import {
  getAddress,
  getBytes,
  id as keccakId,
  toBeHex,
  type Transaction,
  type TransactionReceipt,
} from "ethers";
import { afterAll, describe, expect, it } from "vitest";

import {
  type CallerContext,
  type CallerRequestMap,
  createCallerE2eSession,
  ensureMpcResponseKeyStored,
  readCallerRequestIds as readRequestIds,
} from "../src/caller-session.ts";
import { CALLER_PATH_HEX } from "../src/constants.ts";
import { requireEnv as requireEnvOf } from "../src/e2e-env.ts";
import { fetchFakenetResponse } from "../src/fakenet-responses.ts";
import { injectE2eEnv, installFlowHooks } from "../src/flow-hooks.ts";
import { broadcastSignedTx, evmRpcUrl, getEvmNonce } from "../src/local-evm.ts";
import { banner, logSkip } from "../src/output.ts";
import { pollSignetNotification } from "../src/signet-notifications.ts";

const MINUTE = 60_000;

/** The setup-populated env accumulator (see the base flow file). */
const env = injectE2eEnv();

/** Assert a setup step populated `name`, failing with a pointed message. */
const requireEnv = (name: string): string => requireEnvOf(env, name);

// Wallet facade + caller context + MPC-style readers shared by every test in
// this file (lazily built, so the offline path never touches the network).
// Stopped once in afterAll.
const session = createCallerE2eSession(env);

// TS mirrors of the contract-fixed schema literals (the submit stage pins
// them against the LIVE ledger record). The same JSON drives both
// directions: the EVM output decode and the packed respond encoding.
const BOOL_SCHEMA: AbiSchema = [{ name: "success", type: "bool" }];
const BOOL_UINT_SCHEMA: AbiSchema = [
  { name: "success", type: "bool" },
  { name: "amount", type: "uint256" },
];

/**
 * One SignetEvmTarget method's flow configuration: the unit of growth.
 * Adding a method later means one Solidity function, one submit/verify
 * circuit pair, and one entry here.
 */
interface EvmMethodCase {
  /** The Solidity method name (labels the test stages). */
  name: string;
  /** The Solidity signature the selector derives from, e.g. "isEven(uint256)". */
  signature: string;
  /** The uint256 argument the flow calls the method with. */
  arg: bigint;
  /** The caller request map this method's requests live in. */
  map: CallerRequestMap;
  /** The map's ledger field position (named in the notification). */
  requestsIndexField: number;
  /** TS mirror of the contract-fixed schema (both directions). */
  schema: AbiSchema;
  /** The values deserializeEvmOutput must decode for `arg`. */
  expectedDecoded: AbiDecodedOutput;
  /** The packed respond payload's exact byte width. */
  packedWidth: number;
  /** Resume var: a request id to reuse instead of re-proving the submit. */
  resumeEnvVar: string;
  /** Drive the method's submit circuit. */
  submit(
    context: CallerContext,
    evmNonce: bigint,
    to: Uint8Array,
    argWord: Uint8Array,
  ): Promise<unknown>;
  /** Drive the method's verify circuit. */
  verify(
    context: CallerContext,
    requestId: Uint8Array,
    event: RespondBidirectionalEvent,
    serializedOutput: Uint8Array,
  ): Promise<unknown>;
}

const METHODS: EvmMethodCase[] = [
  {
    name: "isEven",
    signature: "isEven(uint256)",
    arg: 6n,
    map: "signBidirectionalEventMap",
    requestsIndexField: 3,
    schema: BOOL_SCHEMA,
    expectedDecoded: { success: true },
    packedWidth: 1,
    resumeEnvVar: "CALLER_EVM_REQUEST_ID_ISEVEN",
    submit: (context, evmNonce, to, argWord) =>
      context.caller.callTx.submitIsEvenRequest(evmNonce, SIGNET_DEFAULT_KEY_VERSION, to, argWord),
    verify: (context, requestId, event, serializedOutput) =>
      context.caller.callTx.verifyResponse(requestId, event, serializedOutput),
  },
  {
    name: "checkAndDouble",
    signature: "checkAndDouble(uint256)",
    arg: 21n,
    map: "signBidirectionalEventMap69",
    requestsIndexField: 6,
    schema: BOOL_UINT_SCHEMA,
    expectedDecoded: { success: true, amount: 42n },
    packedWidth: 33,
    resumeEnvVar: "CALLER_EVM_REQUEST_ID_CHECKANDDOUBLE",
    submit: (context, evmNonce, to, argWord) =>
      context.caller.callTx.submitCheckAndDoubleRequest(
        evmNonce,
        SIGNET_DEFAULT_KEY_VERSION,
        to,
        argWord,
      ),
    verify: (context, requestId, event, serializedOutput) =>
      context.caller.callTx.verifyCheckAndDoubleResponse(requestId, event, serializedOutput),
  },
];

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("signet-caller real-EVM e2e", () => {
  installFlowHooks();

  afterAll(async () => {
    await session.stop();
  });

  // The derived sender is shared by every method (all submit circuits fix
  // the same path bytes), resolved lazily once env is populated.
  const derivedSender = (): string =>
    deriveEvmAddress(
      requireEnv("MPC_SECP256K1_PUBKEY"),
      requireEnv("MIDNIGHT_CALLER_CONTRACT_ADDRESS"),
      CALLER_PATH_HEX,
    );

  it(
    "initialise [signet-caller contract method call]: the MPC response key is stored (idempotent)",
    async () => {
      // The shared idempotent initialise stage (also run by the base flow
      // file). This file must be self-sufficient, as vitest's sequencer does
      // not guarantee the base file ran first.
      const context = await session.callerContext();
      const mpcResponseKey = parseSecp256k1PublicKey(requireEnv("MPC_RESPONSE_KEY"));
      const outcome = await ensureMpcResponseKeyStored(context, mpcResponseKey);
      expect(outcome).toMatch(/^(stored|already-stored)$/);
    },
    15 * MINUTE,
  );

  for (const method of METHODS) {
    // Per-method state threaded through the ordered stages below.
    let requestId: RequestIdHex;
    let signedTx: Transaction | undefined;
    let receipt: TransactionReceipt;
    let respondBytes: Uint8Array;
    let attestedEvent: RespondBidirectionalEvent;
    // A resumed request may already have been consumed by a prior run's
    // verify. Checked once at resume time so the signature-poll, broadcast
    // and recompute stages skip and the flow routes to the verify stage's
    // already-consumed skip instead of failing in getSignatureRequest.
    let alreadyConsumed = false;

    it(
      `${method.name} submit [signet-caller contract method call]: record the request and pin it MPC-style`,
      async () => {
        const resume = env[method.resumeEnvVar];
        if (resume) {
          requestId = resume as RequestIdHex;
          const context = await session.callerContext();
          alreadyConsumed = !(await readRequestIds(context, method.map)).has(requestId);
          logSkip(
            `${method.name} submit`,
            `${method.resumeEnvVar} present, reusing request '${requestId}'` +
              (alreadyConsumed ? " (already consumed: later stages route to the verify skip)" : ""),
          );
          return;
        }

        const context = await session.callerContext();
        const rpc = evmRpcUrl(env);
        const targetAddress = requireEnv("EVM_TARGET_CONTRACT_ADDRESS");
        const sender = derivedSender();

        // The MPC signs exactly the nonce the request declares, so it must
        // be the sender's current chain nonce at submit time (the previous
        // method's broadcast has already confirmed: stages run in order).
        const evmNonce = await getEvmNonce(rpc, sender);
        const to = hexToBytes(stripHexPrefix(targetAddress));
        const argWord = getBytes(toBeHex(method.arg, 32));

        const before = await readRequestIds(context, method.map);
        await method.submit(context, evmNonce, to, argWord);

        // State indexing lags finalization: poll briefly for the fresh id.
        const deadline = Date.now() + MINUTE;
        let fresh: RequestIdHex[] = [];
        while (fresh.length === 0 && Date.now() < deadline) {
          fresh = [...(await readRequestIds(context, method.map))].filter(
            (entry) => !before.has(entry),
          );
          if (fresh.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        expect(fresh, "the submit must add exactly one request to its map").toHaveLength(1);
        const [firstFresh] = fresh;
        if (firstFresh === undefined) {
          throw new Error("the length assertion above proves this is unreachable");
        }
        requestId = firstFresh;

        // MPC-convention verification: fetch the record the way the response
        // server does and pin the caller-supplied fields, the in-circuit
        // selector literal (against its ethers derivation), the schema
        // literals, and the request-id TS twin.
        const record = await session
          .responseReader(method.requestsIndexField)
          .getSignatureRequest(requestId);
        expect(record.txParams.nonce).toBe(evmNonce);
        expect(record.txParams.to).toEqual(to);
        expect(record.txParams.calldata.is_some).toBe(true);
        expect(record.txParams.calldata.value.selector).toEqual(
          getBytes(keccakId(method.signature).slice(0, 10)),
        );
        expect(record.txParams.calldata.value.words[0]).toEqual(argWord);
        const schemaJson = new TextDecoder().decode(record.respondSerializationSchema);
        expect(JSON.parse(schemaJson)).toEqual(method.schema);
        expect(record.outputDeserializationSchema).toEqual(record.respondSerializationSchema);
        expect(requestId).toBe(requestIdHex(calculateRequestId(record)));

        banner([
          `${method.name} request recorded on the caller ledger (map field ${String(method.requestsIndexField)}):`,
          "",
          `  request id: ${requestId}`,
          `  target:     ${targetAddress}`,
          `  argument:   ${String(method.arg)}`,
        ]);
      },
      15 * MINUTE,
    );

    it(
      `${method.name} notification: emitted on the signet contract naming field ${String(method.requestsIndexField)}`,
      async () => {
        expect(requestId).toBeDefined();
        // The notification declares the stored request's id: id + this
        // method's caller + map-field path is the match key.
        const decoded = await pollSignetNotification({
          env,
          callerAddress: requireEnv("MIDNIGHT_CALLER_CONTRACT_ADDRESS"),
          requestsPath: [method.requestsIndexField],
          requestId,
          description: `declaring request ${requestId} for the caller at path [${String(method.requestsIndexField)}]`,
        });
        expect(decoded.version).toBe(1);
        expect(decoded.callerAddress).toBe(
          stripHexPrefix(requireEnv("MIDNIGHT_CALLER_CONTRACT_ADDRESS")).toLowerCase(),
        );
        // The caller is flat, so its field number is a depth-1 path.
        expect(decoded.requestsPath).toEqual([method.requestsIndexField]);
      },
      2 * MINUTE,
    );

    it(
      `${method.name} pollSignatureResponse: the MPC's signature recovers to the derived sender`,
      async () => {
        expect(requestId).toBeDefined();
        if (alreadyConsumed) {
          logSkip(`${method.name} pollSignatureResponse`, `request ${requestId} already consumed`);
          return;
        }
        const expectedSigner = derivedSender();
        const reader = session.responseReader(method.requestsIndexField);

        const warned = new Set<bigint>();
        const deadline = Date.now() + 3 * MINUTE;
        while (Date.now() < deadline) {
          const { verified, verdicts } = await reader.getVerifiedSignatureRespondedEvent(
            requestId,
            expectedSigner,
          );
          for (const verdict of verdicts) {
            if (verdict.rejectedReason !== undefined && !warned.has(verdict.index)) {
              warned.add(verdict.index);
              console.warn(
                `ignoring response post ${String(verdict.index)}: ${verdict.rejectedReason}`,
              );
            }
          }
          if (verified !== undefined) {
            const request = await reader.getSignatureRequest(requestId);
            signedTx = signBidirectionalEventToSignedEvmTransaction(request, verified);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        // Asserted after the loop: an expect on the success path alone would
        // pass vacuously on a timeout.
        if (signedTx === undefined) {
          throw new Error(
            `timed out waiting for a valid signature response to request ${requestId}`,
          );
        }
        expect(signedTx.from).toBe(getAddress(expectedSigner));
      },
      5 * MINUTE,
    );

    // Cross-flow interaction note: the generic flow's never-broadcast
    // request shares the derived sender and nonce 0 with this flow's first
    // broadcast. Once that transaction mines, the responder posts a benign
    // failure attestation for the (already consumed) generic request, which
    // is expected log noise.
    it(
      `${method.name} broadcast: the signed transaction mines on the local anvil`,
      async () => {
        if (alreadyConsumed) {
          logSkip(`${method.name} broadcast`, `request ${requestId} already consumed`);
          return;
        }
        if (signedTx === undefined) {
          throw new Error(`no signed transaction for request ${requestId}`);
        }
        receipt = await broadcastSignedTx(evmRpcUrl(env), signedTx);
        expect(receipt.status).toBe(1);
        banner([
          `${method.name} transaction mined:`,
          "",
          `  tx hash: ${String(signedTx.hash)}`,
          `  block:   ${String(receipt.blockNumber)}`,
        ]);
      },
      2 * MINUTE,
    );

    it(
      `${method.name} pollRespondBidirectional: the fakenet observes the execution and posts an attestation`,
      async () => {
        expect(requestId).toBeDefined();
        const reader = session.responseReader(method.requestsIndexField);
        const deadline = Date.now() + 5 * MINUTE;
        // Wait for a post declared under THIS request's id (the recompute
        // stage below picks the one that verifies over the recomputed
        // respond bytes).
        let events: RespondBidirectionalEvent[] = [];
        while (events.length === 0 && Date.now() < deadline) {
          events = await reader.getRespondBidirectionalEvents(requestId);
          if (events.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
        expect(
          events.length,
          "the fakenet must post a respond-bidirectional attestation for this request",
        ).toBeGreaterThan(0);
      },
      5 * MINUTE,
    );

    it(
      `${method.name} recompute: deserializeEvmOutput + serializeRespondOutput reproduce the attested output`,
      async () => {
        if (alreadyConsumed) {
          logSkip(`${method.name} recompute`, `request ${requestId} already consumed`);
          return;
        }
        expect(receipt).toBeDefined();

        // Fetch the raw execution output from the fakenet's public
        // /responses/{requestId} helper API: the mined call's actual return
        // data as the fakenet traced it (debug_traceTransaction, the same
        // method the real MPC uses), served so clients need no trace RPC
        // access of their own. UNTRUSTED until an attestation below verifies
        // over the bytes recomputed from it.
        const cached = await fetchFakenetResponse(requestId);
        expect(cached.success, "the fakenet must report a succeeded execution").toBe(true);
        const callResult = cached.output;
        if (callResult === null) {
          throw new Error("a succeeded execution must carry its raw output");
        }

        // The two abi-serde conversions under test, on live protocol data.
        const decoded = deserializeEvmOutput(method.schema, callResult);
        expect(decoded, "the EVM output must decode to the expected values").toEqual(
          method.expectedDecoded,
        );
        respondBytes = serializeRespondOutput(method.schema, decoded);
        expect(
          respondBytes,
          "the packed respond payload must have the schema's exact width",
        ).toHaveLength(method.packedWidth);

        // The signature seals the round trip: the post attests a digest over
        // respond bytes only the fakenet's side produced, so it verifies
        // against the pinned response key ONLY if the fakenet ran the SAME
        // two conversions and got the same bytes we did. The event carries
        // no digest of its own, so this signature check is the whole match.
        //
        // Poll: the declared request id only routes, so a post under this id
        // may still fail verification (for example a failure attestation for
        // a superseded nonce). Wait until a post declared under this id
        // verifies over the recomputed bytes.
        const reader = session.responseReader(method.requestsIndexField);
        const mpcResponseKey = parseSecp256k1PublicKey(requireEnv("MPC_RESPONSE_KEY"));
        const verifyDeadline = Date.now() + 3 * MINUTE;
        let attested: RespondBidirectionalEvent | undefined;
        while (attested === undefined && Date.now() < verifyDeadline) {
          attested = await reader.getVerifiedRespondBidirectionalEvent(
            requestId,
            respondBytes,
            mpcResponseKey,
          );
          if (attested === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
        expect(
          attested,
          "a posted attestation must verify over the recomputed respond bytes",
        ).toBeDefined();
        if (attested === undefined) {
          throw new Error("the toBeDefined assertion above proves this is unreachable");
        }
        attestedEvent = attested;

        banner([
          `${method.name} attestation verifies over the recomputed respond bytes:`,
          "",
          `  raw output: ${callResult} (from the fakenet /responses API)`,
          `  decoded:    ${JSON.stringify(decoded, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`,
          `  payload:    0x${Buffer.from(respondBytes).toString("hex")} (${String(respondBytes.length)} bytes)`,
          `  digest:     0x${Buffer.from(calculateSignetAttestationDigest(requestIdBytes(requestId), respondBytes)).toString("hex")}`,
          "",
          "deserializeEvmOutput and serializeRespondOutput ran on BOTH sides",
          "(fakenet and this suite) and agreed byte for byte.",
        ]);
      },
      5 * MINUTE,
    );

    it(
      `${method.name} verify [signet-caller contract method call]: the attestation verifies in-circuit and consumes the request`,
      async () => {
        expect(requestId).toBeDefined();
        const context = await session.callerContext();

        // Rerun against a kept caller: a prior run may already have consumed
        // the request (checked before the attestedEvent assertion, so a
        // resumed-and-consumed request lands here instead of failing).
        if (!(await readRequestIds(context, method.map)).has(requestId)) {
          logSkip(
            `${method.name} verify`,
            `request ${requestId} already verified (not on the ledger)`,
          );
          return;
        }
        expect(attestedEvent).toBeDefined();

        // The respond bytes recomputed from the API-fetched output go into
        // the circuit, and the sifted event goes in flipped to the verify
        // circuit's input form. The in-circuit digest recompute + signature
        // check is what authenticates them: a tampered output yields a
        // digest the MPC never signed.
        await method.verify(
          context,
          requestIdBytes(requestId),
          respondBidirectionalEventToCircuitInput(attestedEvent),
          respondBytes,
        );

        const deadline = Date.now() + MINUTE;
        let stillPresent = true;
        while (stillPresent && Date.now() < deadline) {
          stillPresent = (await readRequestIds(context, method.map)).has(requestId);
          if (stillPresent) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        expect(stillPresent, "the verify must consume the request from its map").toBe(false);

        banner([`${method.name} request ${requestId} verified in-circuit and consumed.`]);
      },
      15 * MINUTE,
    );
  }
});
