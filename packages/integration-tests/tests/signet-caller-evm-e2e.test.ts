// The REAL-EVM signet e2e flow: the caller contract requests calls against
// the SignetEvmTarget Solidity contract on the local anvil, the MPC signs,
// THIS SUITE broadcasts (the MPC only signs: broadcasting is a client
// responsibility), the fakenet observes the mined execution (via
// debug_traceTransaction, the same RPC method the real MPC uses) and posts
// a respond-bidirectional attestation. The suite then recomputes the respond
// bytes from the mined call's trace (deserializeEvmOutput,
// serializeRespondOutput), checks the fakenet's output cache (the twin of
// the MPC's bucket, for clients without trace access) holds the same bytes,
// and picks the attestation that VERIFIES over them against the pinned MPC
// response key before in-circuit verification. Both the traced and the
// cached bytes are UNTRUSTED until that signature verification passes.
//
// Every outcome kind of the protocol is driven to settlement:
// - executed: isEven and checkAndDouble mine and return data, attested at
//   the respond schema's packed width and settled by the width's verify
//   circuit (checkAndDouble records the returned amount on the ledger).
// - failed: revertIf(true) mines reverted, attested over an EMPTY output and
//   settled at width 0 by verifyFailureResponse.
// - unviable: a signed request that is never broadcast loses its nonce to
//   the isEven broadcast, attested over an EMPTY output at the block that
//   took the nonce and settled by the same width-0 circuit.
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

import type { Ledger as CallerLedger } from "@midnight-protocol/test-caller-contract";
import {
  type AbiDecodedOutput,
  type AbiSchema,
  boolAbiWord,
  calculateRequestId,
  deriveEvmAddress,
  deserializeEvmOutput,
  hexToBytes,
  MpcOutputCacheReader,
  OutputKind,
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
import { getMidnightNodeConfig } from "@sig-net/midnight-contract-deploy";
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
  readCallerLedger,
  readCallerRequestIds as readRequestIds,
} from "../src/caller-session.ts";
import { CALLER_PATH_HEX } from "../src/constants.ts";
import { requireEnv as requireEnvOf } from "../src/e2e-env.ts";
import { injectE2eEnv, installFlowHooks } from "../src/flow-hooks.ts";
import {
  broadcastSignedTx,
  evmRpcUrl,
  findNonceConsumedBlock,
  getEvmNonce,
  traceTopCallOutput,
} from "../src/local-evm.ts";
import { fetchAttestedOutput, mpcOutputCacheUrl } from "../src/mpc-output-cache.ts";
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

/** A failed or unviable execution is attested over an EMPTY output. */
const EMPTY_OUTPUT = new Uint8Array(0);

/** The canonical uint256 ABI word of `value`. */
const uint256Word = (value: bigint): Uint8Array => getBytes(toBeHex(value, 32));

/**
 * The outcome a method's broadcast is expected to reach, which decides how
 * its attestation is recomputed and which verify circuit settles it.
 */
type EvmMethodOutcome =
  | {
      /** The transaction mines (status 1) and returns data. */
      readonly kind: OutputKind.executed;
      /** The values deserializeEvmOutput must decode from the return data. */
      readonly expectedDecoded: AbiDecodedOutput;
      /** The packed respond payload's exact byte width. */
      readonly packedWidth: number;
    }
  | {
      /** The transaction mines reverted (status 0): attested over an empty output. */
      readonly kind: OutputKind.failed;
    };

/**
 * What the ledger must record for a request once its verify circuit
 * consumed it, for the circuits that record something.
 */
interface EvmMethodSettlement {
  /** Names the record for the assertion message. */
  readonly description: string;
  /** Read the record the verify circuit wrote under `requestId`. */
  read(ledger: CallerLedger, requestId: Uint8Array): bigint | OutputKind;
  /** The value the record must hold. */
  readonly expected: bigint | OutputKind;
}

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
  /** The argument as the caller must store it: one canonical ABI word. */
  argWord: Uint8Array;
  /** The argument as the banner prints it. */
  argLabel: string;
  /** The caller request map this method's requests live in. */
  map: CallerRequestMap;
  /** The map's ledger field position (named in the notification). */
  requestsIndexField: number;
  /** TS mirror of the contract-fixed schema (both directions). */
  schema: AbiSchema;
  /** How the broadcast ends and how the attestation is settled. */
  outcome: EvmMethodOutcome;
  /** The ledger record the verify circuit writes, when it writes one. */
  settlement?: EvmMethodSettlement;
  /** Resume var: a request id to reuse instead of re-proving the submit. */
  resumeEnvVar: string;
  /** Drive the method's submit circuit with the typed argument behind `argWord`. */
  submit(context: CallerContext, evmNonce: bigint, to: Uint8Array): Promise<unknown>;
  /** Drive the verify circuit that settles the method's outcome. */
  verify(
    context: CallerContext,
    event: RespondBidirectionalEvent,
    serializedOutput: Uint8Array,
  ): Promise<unknown>;
}

const METHODS: EvmMethodCase[] = [
  {
    name: "isEven",
    signature: "isEven(uint256)",
    argWord: uint256Word(6n),
    argLabel: "6",
    map: "signBidirectionalEventMap",
    requestsIndexField: 3,
    schema: BOOL_SCHEMA,
    outcome: { kind: OutputKind.executed, expectedDecoded: { success: true }, packedWidth: 1 },
    resumeEnvVar: "CALLER_EVM_REQUEST_ID_ISEVEN",
    submit: (context, evmNonce, to) =>
      context.caller.callTx.submitIsEvenRequest(
        evmNonce,
        SIGNET_DEFAULT_KEY_VERSION,
        to,
        uint256Word(6n),
      ),
    verify: (context, event, serializedOutput) =>
      context.caller.callTx.verifyResponse(event, serializedOutput),
  },
  {
    name: "checkAndDouble",
    signature: "checkAndDouble(uint256)",
    argWord: uint256Word(21n),
    argLabel: "21",
    map: "signBidirectionalEventMap69",
    requestsIndexField: 6,
    schema: BOOL_UINT_SCHEMA,
    outcome: {
      kind: OutputKind.executed,
      expectedDecoded: { success: true, amount: 42n },
      packedWidth: 33,
    },
    settlement: {
      description: "the amount checkAndDouble returned, deserialised in-circuit",
      read: (ledger, requestId) => ledger.checkAndDoubleAmounts.lookup(requestId),
      expected: 42n,
    },
    resumeEnvVar: "CALLER_EVM_REQUEST_ID_CHECKANDDOUBLE",
    submit: (context, evmNonce, to) =>
      context.caller.callTx.submitCheckAndDoubleRequest(
        evmNonce,
        SIGNET_DEFAULT_KEY_VERSION,
        to,
        uint256Word(21n),
      ),
    verify: (context, event, serializedOutput) =>
      context.caller.callTx.verifyCheckAndDoubleResponse(event, serializedOutput),
  },
  {
    // The Boolean is composed into its ABI word in-circuit (boolAbiWord).
    name: "revertIf",
    signature: "revertIf(bool)",
    argWord: boolAbiWord(true),
    argLabel: "true",
    map: "signBidirectionalEventMap",
    requestsIndexField: 3,
    schema: BOOL_SCHEMA,
    outcome: { kind: OutputKind.failed },
    settlement: {
      description: "the MPC's verdict on the reverted transaction",
      read: (ledger, requestId) => ledger.failureVerdicts.lookup(requestId),
      expected: OutputKind.failed,
    },
    resumeEnvVar: "CALLER_EVM_REQUEST_ID_REVERTIF",
    submit: (context, evmNonce, to) =>
      context.caller.callTx.submitRevertIfRequest(evmNonce, SIGNET_DEFAULT_KEY_VERSION, to, true),
    verify: (context, event, serializedOutput) =>
      context.caller.callTx.verifyFailureResponse(event, serializedOutput),
  },
];

/** The first METHODS entry: its broadcast is the one that takes the superseded request's nonce. */
const [FIRST_METHOD] = METHODS;
if (FIRST_METHOD === undefined) {
  throw new Error("METHODS must name at least one target method");
}

/**
 * Poll `read` until it returns a value or `timeoutMs` elapses.
 *
 * @param read - The lookup to repeat.
 * @param timeoutMs - How long to keep polling.
 * @param intervalMs - The pause between polls.
 * @returns The first defined value, or undefined at the deadline.
 */
async function pollUntilDefined<T>(
  read: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (value === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    value = await read();
  }
  return value;
}

/**
 * Drive one verify circuit and wait for the request to leave its map: the
 * consumption is the observable effect, and it only happens once every
 * in-circuit check passed.
 *
 * @param context - The session's caller context.
 * @param map - The request map the request lives in.
 * @param requestId - The request the verify consumes.
 * @param verify - The circuit call.
 */
async function verifyAndAwaitConsumption(
  context: CallerContext,
  map: CallerRequestMap,
  requestId: RequestIdHex,
  verify: () => Promise<unknown>,
): Promise<void> {
  await verify();
  const consumed = await pollUntilDefined(
    async () => ((await readRequestIds(context, map)).has(requestId) ? undefined : true),
    MINUTE,
    1000,
  );
  expect(consumed, "the verify must consume the request from its map").toBe(true);
}

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

  // ---- The superseded request: signed at the first method's nonce, never broadcast ----
  //
  // Submitted BEFORE the method pipelines so the MPC signs it for the same
  // nonce the first broadcast then spends. It is an isEven(7) request, so
  // its id differs from the isEven(6) leg's and from the generic flow's
  // fixed request. Once the first method mines, the fakenet finds the nonce
  // taken and attests the request unviable at that block, and the stages
  // after the pipelines settle that attestation.
  let supersededRequestId: RequestIdHex;
  let supersededConsumed = false;

  it(
    "superseded submit [signet-caller contract method call]: an isEven(7) request at the nonce the first broadcast will take",
    async () => {
      const resume = env.CALLER_EVM_REQUEST_ID_SUPERSEDED;
      const context = await session.callerContext();
      if (resume) {
        supersededRequestId = resume as RequestIdHex;
        supersededConsumed = !(await readRequestIds(context)).has(supersededRequestId);
        logSkip(
          "superseded submit",
          `CALLER_EVM_REQUEST_ID_SUPERSEDED present, reusing request '${supersededRequestId}'` +
            (supersededConsumed ? " (already consumed: later stages skip)" : ""),
        );
        return;
      }

      const rpc = evmRpcUrl(env);
      const sender = derivedSender();
      const evmNonce = await getEvmNonce(rpc, sender);
      const to = hexToBytes(stripHexPrefix(requireEnv("EVM_TARGET_CONTRACT_ADDRESS")));

      const before = await readRequestIds(context);
      await context.caller.callTx.submitIsEvenRequest(
        evmNonce,
        SIGNET_DEFAULT_KEY_VERSION,
        to,
        uint256Word(7n),
      );
      const fresh = await pollUntilDefined(
        async () => {
          const added = [...(await readRequestIds(context))].filter((entry) => !before.has(entry));
          return added.length === 0 ? undefined : added;
        },
        MINUTE,
        1000,
      );
      expect(fresh, "the submit must add exactly one request to the bool-schema map").toHaveLength(
        1,
      );
      const [firstFresh] = fresh ?? [];
      if (firstFresh === undefined) {
        throw new Error("the length assertion above proves this is unreachable");
      }
      supersededRequestId = firstFresh;

      const record = await session.responseReader().getSignatureRequest(supersededRequestId);
      expect(record.txParams.nonce).toBe(evmNonce);

      banner([
        `superseded request recorded on the caller ledger:`,
        "",
        `  request id: ${supersededRequestId}`,
        `  nonce:      ${String(evmNonce)} (the nonce ${FIRST_METHOD.name}'s broadcast takes next)`,
        "",
        "This request is signed by the MPC and never broadcast.",
      ]);
    },
    15 * MINUTE,
  );

  it(
    "superseded pollSignatureResponse: the MPC signs the request it will later find unviable",
    async () => {
      expect(supersededRequestId).toBeDefined();
      if (supersededConsumed) {
        logSkip(
          "superseded pollSignatureResponse",
          `request ${supersededRequestId} already consumed`,
        );
        return;
      }
      const expectedSigner = derivedSender();
      const reader = session.responseReader();
      const signedTx = await pollUntilDefined(
        async () => {
          const { verified } = await reader.getVerifiedSignatureRespondedEvent(
            supersededRequestId,
            expectedSigner,
          );
          if (verified === undefined) {
            return undefined;
          }
          const request = await reader.getSignatureRequest(supersededRequestId);
          return signBidirectionalEventToSignedEvmTransaction(request, verified);
        },
        3 * MINUTE,
        1000,
      );
      if (signedTx === undefined) {
        throw new Error(
          `timed out waiting for a valid signature response to request ${supersededRequestId}`,
        );
      }
      expect(signedTx.from).toBe(getAddress(expectedSigner));
    },
    5 * MINUTE,
  );

  for (const method of METHODS) {
    // Per-method state threaded through the ordered stages below.
    let requestId: RequestIdHex;
    let signedTx: Transaction | undefined;
    let receipt: TransactionReceipt;
    // A failed execution has no output to recover, so its respond bytes are
    // known up front. An executed one's come from the recompute stage.
    let respondBytes: Uint8Array | undefined =
      method.outcome.kind === OutputKind.failed ? EMPTY_OUTPUT : undefined;
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

        const before = await readRequestIds(context, method.map);
        await method.submit(context, evmNonce, to);

        // State indexing lags finalization: poll briefly for the fresh id.
        const fresh = await pollUntilDefined(
          async () => {
            const added = [...(await readRequestIds(context, method.map))].filter(
              (entry) => !before.has(entry),
            );
            return added.length === 0 ? undefined : added;
          },
          MINUTE,
          1000,
        );
        expect(fresh, "the submit must add exactly one request to its map").toHaveLength(1);
        const [firstFresh] = fresh ?? [];
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
        expect(record.txParams.calldata.value.words[0]).toEqual(method.argWord);
        const schemaJson = new TextDecoder().decode(record.respondSerializationSchema);
        expect(JSON.parse(schemaJson)).toEqual(method.schema);
        expect(record.outputDeserializationSchema).toEqual(record.respondSerializationSchema);
        expect(requestId).toBe(requestIdHex(calculateRequestId(record)));

        banner([
          `${method.name} request recorded on the caller ledger (map field ${String(method.requestsIndexField)}):`,
          "",
          `  request id: ${requestId}`,
          `  target:     ${targetAddress}`,
          `  argument:   ${method.argLabel}`,
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
        signedTx = await pollUntilDefined(
          async () => {
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
            if (verified === undefined) {
              return undefined;
            }
            const request = await reader.getSignatureRequest(requestId);
            return signBidirectionalEventToSignedEvmTransaction(request, verified);
          },
          3 * MINUTE,
          1000,
        );
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
    // broadcast on a fresh chain. Once that transaction mines, the responder
    // posts an unviable attestation for the (already consumed) generic
    // request, which is expected log noise.
    it(
      `${method.name} broadcast: the signed transaction mines on the local anvil with status ${method.outcome.kind === OutputKind.executed ? "1" : "0 (reverted)"}`,
      async () => {
        if (alreadyConsumed) {
          logSkip(`${method.name} broadcast`, `request ${requestId} already consumed`);
          return;
        }
        if (signedTx === undefined) {
          throw new Error(`no signed transaction for request ${requestId}`);
        }
        receipt = await broadcastSignedTx(evmRpcUrl(env), signedTx);
        expect(receipt.status, "the mined status must match the method's expected outcome").toBe(
          method.outcome.kind === OutputKind.executed ? 1 : 0,
        );
        banner([
          `${method.name} transaction mined (status ${String(receipt.status)}):`,
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
        // Wait for a post declared under THIS request's id (the recompute
        // stage below picks the one that verifies over the recomputed
        // respond bytes).
        const events = await pollUntilDefined(
          async () => {
            const posts = await reader.getRespondBidirectionalEvents(requestId);
            return posts.length === 0 ? undefined : posts;
          },
          5 * MINUTE,
          2000,
        );
        expect(
          events,
          "the fakenet must post a respond-bidirectional attestation for this request",
        ).toBeDefined();
      },
      5 * MINUTE,
    );

    const outcome = method.outcome;
    if (outcome.kind === OutputKind.executed) {
      it(
        `${method.name} recompute: deserializeEvmOutput + serializeRespondOutput reproduce the attested output`,
        async () => {
          if (alreadyConsumed) {
            logSkip(`${method.name} recompute`, `request ${requestId} already consumed`);
            return;
          }
          // Recompute route: the mined call's return data, read from the
          // local anvil with debug_traceTransaction (the method the MPC
          // observes with), through the two abi-serde conversions under test
          // on live protocol data.
          const callResult = await traceTopCallOutput(evmRpcUrl(env), receipt.hash);
          const decoded = deserializeEvmOutput(method.schema, callResult);
          expect(decoded, "the EVM output must decode to the expected values").toEqual(
            outcome.expectedDecoded,
          );
          respondBytes = serializeRespondOutput(method.schema, decoded);
          expect(
            respondBytes,
            "the packed respond payload must have the schema's exact width",
          ).toHaveLength(outcome.packedWidth);

          banner([
            `${method.name} respond bytes recomputed from the mined call's trace:`,
            "",
            `  raw output: ${callResult}`,
            `  decoded:    ${JSON.stringify(decoded, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`,
            `  payload:    0x${Buffer.from(respondBytes).toString("hex")} (${String(respondBytes.length)} bytes)`,
          ]);
        },
        2 * MINUTE,
      );
    }

    it(
      `${method.name} attestation: the fakenet cached the respond bytes and its post verifies over them as ${OutputKind[outcome.kind]}`,
      async () => {
        if (alreadyConsumed) {
          logSkip(`${method.name} attestation`, `request ${requestId} already consumed`);
          return;
        }
        if (respondBytes === undefined) {
          throw new Error(
            `no respond bytes for request ${requestId}: the recompute stage did not run`,
          );
        }
        const bytes = respondBytes;

        // Cache route: the bytes the fakenet wrote to its output cache before
        // posting, read exactly as a client without trace access reads a real
        // MPC's bucket. The cache holds what the attestation commits to, so
        // they must equal the recomputed bytes to the byte (an empty object
        // for a failure).
        const outputCache = new MpcOutputCacheReader({
          cacheUrl: mpcOutputCacheUrl(env),
          networkId: getMidnightNodeConfig(env).networkId,
          signetContractAddress: requireEnv("MIDNIGHT_SIGNET_CONTRACT_ADDRESS"),
        });
        const cached = await fetchAttestedOutput(outputCache, requestId);
        expect(cached, "the fakenet must cache exactly the bytes a client recomputes").toEqual(
          bytes,
        );

        // The signature seals the round trip: the post attests a digest over
        // respond bytes only the fakenet's side produced, so it verifies
        // against the pinned response key ONLY if the fakenet ran the SAME
        // conversions and got the same bytes we did.
        //
        // Poll: the declared request id only routes, so a post under this id
        // may still fail verification. Wait until a post declared under this
        // id verifies over the recomputed bytes.
        const reader = session.responseReader(method.requestsIndexField);
        const mpcResponseKey = parseSecp256k1PublicKey(requireEnv("MPC_RESPONSE_KEY"));
        const attested = await pollUntilDefined(
          () => reader.getVerifiedRespondBidirectionalEvent(requestId, bytes, mpcResponseKey),
          3 * MINUTE,
          2000,
        );
        expect(
          attested,
          "a posted attestation must verify over the recomputed respond bytes",
        ).toBeDefined();
        if (attested === undefined) {
          throw new Error("the toBeDefined assertion above proves this is unreachable");
        }
        attestedEvent = attested;
        expect(attested.outputKind, "the attested kind must be the method's expected outcome").toBe(
          outcome.kind,
        );
        expect(attested.blockHeight, "the attested block height must be the receipt's block").toBe(
          BigInt(receipt.blockNumber),
        );
        expect(attested.serializedOutputLength, "the posted output width").toBe(
          BigInt(bytes.length),
        );
        const digest = calculateSignetAttestationDigest(
          requestIdBytes(requestId),
          attested.blockHeight,
          attested.outputKind,
          bytes,
        );
        expect(attested.digest, "the posted digest must be the one recomputed here").toEqual(
          digest,
        );

        banner([
          `${method.name} attestation verifies over the respond bytes:`,
          "",
          `  payload: 0x${Buffer.from(bytes).toString("hex")} (${String(bytes.length)} bytes)`,
          `  height:  ${String(attested.blockHeight)} (posted by the MPC, equal to the receipt's block)`,
          `  kind:    ${OutputKind[attested.outputKind]} (posted by the MPC)`,
          `  digest:  0x${Buffer.from(digest).toString("hex")}`,
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
        if (respondBytes === undefined) {
          throw new Error(
            `no respond bytes for request ${requestId}: the recompute stage did not run`,
          );
        }

        // The recomputed respond bytes go into the circuit, and the sifted
        // event goes in flipped to the verify circuit's input form. The
        // in-circuit digest recompute + signature check is what
        // authenticates them: a tampered output yields a digest the MPC
        // never signed.
        await verifyAndAwaitConsumption(context, method.map, requestId, () =>
          method.verify(
            context,
            respondBidirectionalEventToCircuitInput(attestedEvent),
            respondBytes ?? EMPTY_OUTPUT,
          ),
        );

        banner([`${method.name} request ${requestId} verified in-circuit and consumed.`]);
      },
      15 * MINUTE,
    );

    const settlement = method.settlement;
    if (settlement !== undefined) {
      it(
        `${method.name} settlement: the ledger records ${settlement.description}`,
        async () => {
          expect(requestId).toBeDefined();
          const context = await session.callerContext();
          // Written by the verify circuit in the same transaction that
          // consumed the request, so it is present whenever the request is
          // gone, on a rerun against a kept caller too.
          const recorded = settlement.read(
            await readCallerLedger(context),
            requestIdBytes(requestId),
          );
          expect(recorded).toBe(settlement.expected);
        },
        MINUTE,
      );
    }
  }

  // ---- The superseded request's settlement, once the first method took its nonce ----

  let supersededAttestation: RespondBidirectionalEvent;

  it(
    "superseded pollRespondBidirectional: the fakenet attests the request unviable at the block that took its nonce",
    async () => {
      expect(supersededRequestId).toBeDefined();
      if (supersededConsumed) {
        logSkip(
          "superseded pollRespondBidirectional",
          `request ${supersededRequestId} already consumed`,
        );
        return;
      }
      // The fakenet's own verdict: it never saw the signed transaction
      // mine, found the nonce spent, and attested over an empty output.
      const reader = session.responseReader();
      const mpcResponseKey = parseSecp256k1PublicKey(requireEnv("MPC_RESPONSE_KEY"));
      const attested = await pollUntilDefined(
        () =>
          reader.getVerifiedRespondBidirectionalEvent(
            supersededRequestId,
            EMPTY_OUTPUT,
            mpcResponseKey,
          ),
        5 * MINUTE,
        2000,
      );
      expect(
        attested,
        "the fakenet must attest the superseded request over an empty output",
      ).toBeDefined();
      if (attested === undefined) {
        throw new Error("the toBeDefined assertion above proves this is unreachable");
      }
      supersededAttestation = attested;
      expect(attested.outputKind, "a request whose nonce another transaction took").toBe(
        OutputKind.unviable,
      );
      expect(attested.serializedOutputLength).toBe(0n);
      // The attested height is the block that spent the request's nonce,
      // found here by an independent bisection of the sender's transaction
      // count (the first method's broadcast is the transaction that spent it).
      const request = await reader.getSignatureRequest(supersededRequestId);
      const nonceTakenBlock = await findNonceConsumedBlock(
        evmRpcUrl(env),
        derivedSender(),
        request.txParams.nonce,
      );
      expect(
        attested.blockHeight,
        "the attested height must be the block that spent the nonce",
      ).toBe(nonceTakenBlock);

      banner([
        `superseded request ${supersededRequestId} attested by the fakenet:`,
        "",
        `  kind:    ${OutputKind[attested.outputKind]}`,
        `  height:  ${String(attested.blockHeight)} (the block that spent nonce ${String(request.txParams.nonce)})`,
        `  payload: (empty, 0 bytes)`,
      ]);
    },
    10 * MINUTE,
  );

  it(
    "superseded verify [signet-caller contract method call]: verifyFailureResponse settles the unviable attestation at width 0",
    async () => {
      expect(supersededRequestId).toBeDefined();
      const context = await session.callerContext();
      if (!(await readRequestIds(context)).has(supersededRequestId)) {
        logSkip(
          "superseded verify",
          `request ${supersededRequestId} already settled (not on the ledger)`,
        );
        return;
      }
      expect(supersededAttestation).toBeDefined();

      await verifyAndAwaitConsumption(
        context,
        "signBidirectionalEventMap",
        supersededRequestId,
        () =>
          context.caller.callTx.verifyFailureResponse(
            respondBidirectionalEventToCircuitInput(supersededAttestation),
            EMPTY_OUTPUT,
          ),
      );

      const verdict = (await readCallerLedger(context)).failureVerdicts.lookup(
        requestIdBytes(supersededRequestId),
      );
      expect(verdict, "the recorded verdict is the MPC's").toBe(OutputKind.unviable);

      banner([
        `superseded request ${supersededRequestId} settled in-circuit as ${OutputKind[OutputKind.unviable]}.`,
      ]);
    },
    15 * MINUTE,
  );
});
