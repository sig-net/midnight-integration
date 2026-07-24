// The REAL-EVM signet e2e flow: the caller contract requests calls against
// the SignetEvmTarget Solidity contract on the local anvil, the MPC signs,
// THIS SUITE broadcasts (the MPC only signs — broadcasting is a client
// responsibility), the fakenet observes the mined execution and posts a
// respond-bidirectional attestation, and the suite independently recomputes
// the respond bytes (eth_call mirroring the fakenet, deserializeEvmOutput,
// serializeRespondOutput, calculateSignetAttestationDigest) and matches the
// attested digest before in-circuit verification. Both abi-serde functions
// therefore run twice per method — producer side in the fakenet, verifier
// side here — with byte-equality pinned by the keccak digest.
//
// One ordered pipeline per target method, driven by the METHODS config
// below: adding a Solidity method later means one Solidity function, one
// submit/verify circuit pair (a new exact-width request map when the schema
// width is new), and one METHODS entry. Tests run in source order and feed
// each other through per-method state; the file is self-sufficient (its own
// idempotent initialise stage), so it does not depend on the base EVM-free
// flow file having run first.
//
// The request-id envelope of the caller contract changed when the EVM
// circuits landed, so a MIDNIGHT_CALLER_CONTRACT_ADDRESS kept from an older
// deploy will fail: unset it (plus MPC_RESPONSE_KEY and any CALLER_*
// request-id resume vars) for one clean redeploy.

import {
  calculateRequestId,
  calculateSignetAttestationDigest,
  deriveEvmAddress,
  deserializeEvmOutput,
  hexToBytes,
  parseSecp256k1PublicKey,
  requestIdBytes,
  requestIdHex,
  serializeRespondOutput,
  signBidirectionalEventToSignedEVMTransaction,
  stripHexPrefix,
  toSignBidirectionalEventIndex,
  SIGNET_DEFAULT_KEY_VERSION,
  type AbiDecodedOutput,
  type AbiSchema,
  type RequestIdHex,
  type RespondBidirectionalEvent,
} from "@sig-net/midnight";
import { ledger as callerContractLedger } from "@midnight-protocol/test-caller-contract";
import { JsonRpcProvider, getAddress, getBytes, id as keccakId, toBeHex, type Transaction, type TransactionReceipt } from "ethers";
import { afterAll, describe, expect, it } from "vitest";
import { createCallerE2eSession, type CallerContext } from "../src/caller-session.ts";
import { requireEnv as requireEnvOf } from "../src/e2e-env.ts";
import { injectE2eEnv, installFlowHooks } from "../src/flow-hooks.ts";
import { broadcastSignedTx, evmRpcUrl, getEvmNonce } from "../src/local-evm.ts";
import { banner, logSkip } from "../src/output.ts";
import { CALLER_PATH } from "../src/setup/evm-steps.ts";
import { pollSignetNotification } from "../src/signet-notifications.ts";

const MINUTE = 60_000;

/** The setup-populated env accumulator (see the base flow file). */
const env = injectE2eEnv();

/** Assert a setup step populated `name`, failing with a pointed message. */
const requireEnv = (name: string): string => requireEnvOf(env, name);

// Wallet facade + caller context + MPC-style readers shared by every test in
// this file (lazily built, so the offline path never touches the network);
// stopped once in afterAll.
const session = createCallerE2eSession(env);

/** The two per-schema-width request maps the caller contract keeps. */
type CallerRequestMap = "signBidirectionalEventMap" | "signBidirectionalEventMap69";

/**
 * Read one caller request map's keys — present request ids as hex.
 *
 * @param context - The session's caller context.
 * @param map - Which per-width map to read.
 * @returns The set of request ids currently in that map.
 * @throws Error when the contract has no state on-chain.
 */
const readRequestIds = async (
  context: CallerContext,
  map: CallerRequestMap,
): Promise<Set<RequestIdHex>> => {
  const contractState = await context.providers.publicDataProvider.queryContractState(context.contractAddress);
  if (!contractState) {
    throw new Error(`no contract state found at ${context.contractAddress}`);
  }
  return new Set(toSignBidirectionalEventIndex(callerContractLedger(contractState.data)[map]).keys());
};

// TS mirrors of the contract-fixed schema literals (the submit stage pins
// them against the LIVE ledger record). The same JSON drives both
// directions: the EVM output decode and the packed respond encoding.
const BOOL_SCHEMA: AbiSchema = [{ name: "success", type: "bool" }];
const BOOL_UINT_SCHEMA: AbiSchema = [
  { name: "success", type: "bool" },
  { name: "amount", type: "uint256" },
];

/**
 * One SignetEvmTarget method's flow configuration — the unit of growth.
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
  submit(context: CallerContext, evmNonce: bigint, to: Uint8Array, argWord: Uint8Array): Promise<unknown>;
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
    requestsIndexField: 4,
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
    requestsIndexField: 7,
    schema: BOOL_UINT_SCHEMA,
    expectedDecoded: { success: true, amount: 42n },
    packedWidth: 33,
    resumeEnvVar: "CALLER_EVM_REQUEST_ID_CHECKANDDOUBLE",
    submit: (context, evmNonce, to, argWord) =>
      context.caller.callTx.submitCheckAndDoubleRequest(evmNonce, SIGNET_DEFAULT_KEY_VERSION, to, argWord),
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
  // the same "caller-path"), resolved lazily once env is populated.
  const derivedSender = (): string =>
    deriveEvmAddress(requireEnv("MPC_SECP256K1_PUBKEY"), requireEnv("MIDNIGHT_CALLER_CONTRACT_ADDRESS"), CALLER_PATH);

  it(
    "initialise [signet-caller contract method call]: the MPC response key is stored (idempotent)",
    async () => {
      // Same idempotent logic as the base flow file's initialise stage: this
      // file must be self-sufficient, vitest's sequencer does not guarantee
      // the base file ran first.
      const context = await session.callerContext();
      const mpcResponseKey = parseSecp256k1PublicKey(requireEnv("MPC_RESPONSE_KEY"));

      const readKeyState = async () => {
        const state = await context.providers.publicDataProvider.queryContractState(context.contractAddress);
        if (!state) {
          throw new Error(`no contract state found at ${context.contractAddress}`);
        }
        const decoded = callerContractLedger(state.data);
        return { initialised: decoded.initialised, storedKey: decoded.mpcResponseKey };
      };

      const before = await readKeyState();
      if (before.initialised !== 0n) {
        expect(before.storedKey, "the stored key must match the derived MPC_RESPONSE_KEY").toEqual(mpcResponseKey);
        logSkip("initialise", "the MPC response key is already stored");
        return;
      }

      await context.caller.callTx.initialise(mpcResponseKey);

      const deadline = Date.now() + MINUTE;
      let current = await readKeyState();
      while (current.initialised === 0n && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        current = await readKeyState();
      }
      expect(current.initialised, "initialise must flip the sentinel").toBe(1n);
      expect(current.storedKey, "initialise must store MPC_RESPONSE_KEY verbatim").toEqual(mpcResponseKey);
    },
    15 * MINUTE,
  );

  for (const method of METHODS) {
    // Per-method state threaded through the ordered stages below.
    let requestId: RequestIdHex;
    let signedTx: Transaction;
    let receipt: TransactionReceipt;
    let respondBytes: Uint8Array;
    let attestedEvent: RespondBidirectionalEvent;

    it(
      `${method.name} submit [signet-caller contract method call]: record the request and pin it MPC-style`,
      async () => {
        const resume = env[method.resumeEnvVar];
        if (resume) {
          requestId = resume as RequestIdHex;
          logSkip(`${method.name} submit`, `${method.resumeEnvVar} present, reusing request '${requestId}'`);
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
          fresh = [...(await readRequestIds(context, method.map))].filter((entry) => !before.has(entry));
          if (fresh.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        expect(fresh, "the submit must add exactly one request to its map").toHaveLength(1);
        requestId = fresh[0]!;

        // MPC-convention verification: fetch the record the way the response
        // server does and pin the caller-supplied fields, the in-circuit
        // selector literal (against its ethers derivation), the schema
        // literals, and the request-id TS twin.
        const record = await session.responseReader(method.requestsIndexField).getSignatureRequest(requestId);
        expect(record.txParams.nonce).toBe(evmNonce);
        expect(record.txParams.to).toEqual(to);
        expect(record.txParams.calldata.is_some).toBe(true);
        expect(record.txParams.calldata.value.selector).toEqual(getBytes(keccakId(method.signature).slice(0, 10)));
        expect(record.txParams.calldata.value.words[0]).toEqual(argWord);
        const schemaJson = new TextDecoder().decode(record.respondSerializationSchema);
        expect(JSON.parse(schemaJson)).toEqual(method.schema);
        expect(record.outputDeserializationSchema).toEqual(record.respondSerializationSchema);
        expect(requestId).toBe(requestIdHex(calculateRequestId(record)));

        banner([
          `${method.name} request recorded on the caller ledger (map field ${method.requestsIndexField}):`,
          "",
          `  request id: ${requestId}`,
          `  target:     ${targetAddress}`,
          `  argument:   ${method.arg}`,
        ]);
      },
      15 * MINUTE,
    );

    it(
      `${method.name} notification: registered in the signet registry under field ${method.requestsIndexField}`,
      async () => {
        expect(requestId).toBeDefined();
        const decoded = await pollSignetNotification({
          env,
          requestId,
          description: `for request ${requestId}`,
        });
        expect(decoded.version).toBe(1);
        expect(decoded.callerAddress).toBe(stripHexPrefix(requireEnv("MIDNIGHT_CALLER_CONTRACT_ADDRESS")).toLowerCase());
        expect(decoded.requestsIndexField).toBe(method.requestsIndexField);
      },
      2 * MINUTE,
    );

    it(
      `${method.name} pollSignatureResponse: the MPC's signature recovers to the derived sender`,
      async () => {
        expect(requestId).toBeDefined();
        const expectedSigner = derivedSender();
        const reader = session.responseReader(method.requestsIndexField);

        const warned = new Set<bigint>();
        const deadline = Date.now() + 3 * MINUTE;
        while (Date.now() < deadline) {
          const { verified, verdicts } = await reader.getVerifiedSignatureRespondedEvent(requestId, expectedSigner);
          for (const verdict of verdicts) {
            if (verdict.rejectedReason !== undefined && !warned.has(verdict.count)) {
              warned.add(verdict.count);
              console.warn(`ignoring response post ${verdict.count}: ${verdict.rejectedReason}`);
            }
          }
          if (verified !== undefined) {
            const request = await reader.getSignatureRequest(requestId);
            signedTx = signBidirectionalEventToSignedEVMTransaction(request, verified);
            expect(signedTx.from).toBe(getAddress(expectedSigner));
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        throw new Error(`timed out waiting for a valid signature response to request ${requestId}`);
      },
      5 * MINUTE,
    );

    it(
      `${method.name} broadcast: the signed transaction mines on the local anvil`,
      async () => {
        expect(signedTx).toBeDefined();
        receipt = await broadcastSignedTx(evmRpcUrl(env), signedTx);
        expect(receipt.status).toBe(1);
        banner([
          `${method.name} transaction mined:`,
          "",
          `  tx hash: ${signedTx.hash}`,
          `  block:   ${receipt.blockNumber}`,
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
        let events: RespondBidirectionalEvent[] = [];
        while (events.length === 0 && Date.now() < deadline) {
          events = await reader.getRespondBidirectionalEvents(requestId);
          if (events.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
        expect(events.length, "the fakenet must post a respond-bidirectional attestation").toBeGreaterThan(0);
      },
      5 * MINUTE,
    );

    it(
      `${method.name} recompute: deserializeEvmOutput + serializeRespondOutput reproduce the attested digest`,
      async () => {
        expect(receipt).toBeDefined();

        // Mirror the fakenet's extraction EXACTLY: re-simulate the mined
        // call against the previous block's state from the derived sender.
        const provider = new JsonRpcProvider(evmRpcUrl(env));
        let callResult: string;
        try {
          callResult = await provider.call({
            to: signedTx.to,
            data: signedTx.data,
            from: signedTx.from,
            blockTag: receipt.blockNumber - 1,
          });
        } finally {
          provider.destroy();
        }

        // The two abi-serde conversions under test, on live protocol data.
        const decoded = deserializeEvmOutput(method.schema, callResult);
        expect(decoded, "the EVM output must decode to the expected values").toEqual(method.expectedDecoded);
        respondBytes = serializeRespondOutput(method.schema, decoded);
        expect(respondBytes, "the packed respond payload must have the schema's exact width").toHaveLength(method.packedWidth);

        // The digest seals the round trip: the fakenet ran the SAME two
        // conversions on its side, so its attested digest must equal the
        // digest of our independent recomputation, byte for byte.
        const digest = calculateSignetAttestationDigest(requestIdBytes(requestId), respondBytes);
        const events = await session.responseReader(method.requestsIndexField).getRespondBidirectionalEvents(requestId);
        const matching = events.find(
          (event) => Buffer.from(event.attestationDigest).equals(Buffer.from(digest)),
        );
        expect(matching, "an attested digest must match the recomputed respond bytes").toBeDefined();
        attestedEvent = matching!;

        banner([
          `${method.name} attestation matches the independent recomputation:`,
          "",
          `  decoded:   ${JSON.stringify(decoded, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`,
          `  payload:   0x${Buffer.from(respondBytes).toString("hex")} (${respondBytes.length} bytes)`,
          `  digest:    0x${Buffer.from(digest).toString("hex")}`,
          "",
          "deserializeEvmOutput and serializeRespondOutput ran on BOTH sides",
          "(fakenet and this suite) and agreed byte for byte.",
        ]);
      },
      2 * MINUTE,
    );

    it(
      `${method.name} verify [signet-caller contract method call]: the attestation verifies in-circuit and consumes the request`,
      async () => {
        expect(attestedEvent).toBeDefined();
        const context = await session.callerContext();

        // Rerun against a kept caller: a prior run may already have consumed
        // the request.
        if (!(await readRequestIds(context, method.map)).has(requestId)) {
          logSkip(`${method.name} verify`, `request ${requestId} already verified (not on the ledger)`);
          return;
        }

        // The RECOMPUTED bytes go into the circuit — nothing output-shaped
        // is taken from the fakenet, only the attestation being verified.
        await method.verify(context, requestIdBytes(requestId), attestedEvent, respondBytes);

        const deadline = Date.now() + MINUTE;
        let stillPresent = true;
        while (stillPresent && Date.now() < deadline) {
          stillPresent = (await readRequestIds(context, method.map)).has(requestId);
          if (stillPresent) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        expect(stillPresent, "the verify must consume the request from its map").toBe(false);

        banner([
          `${method.name} request ${requestId} verified in-circuit and consumed.`,
        ]);
      },
      15 * MINUTE,
    );
  }
});
