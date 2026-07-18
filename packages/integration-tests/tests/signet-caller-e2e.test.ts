// The generic signet e2e flow: the minimal caller contract drives the
// central signet contract end to end — submit a signature request (with
// contract-fixed minimal calldata), watch the notification land in the
// singleton's registry, poll the MPC's signature response and verify it
// against the caller's derived account, then verify a Schnorr attestation
// in-circuit — against contracts the caller globalSetup pipeline
// (src/setup/caller-global-setup.ts, wired by vitest.config.ts) has
// already compiled/deployed. Tests in THIS file run in source order and feed
// each other through module-scoped state, so the file is one ordered
// pipeline on purpose. Run with `yarn test:integration-tests` (or the
// file-scoped `yarn test:integration-tests:signet-caller-e2e`) from the repo
// root; without RUN_INTEGRATION_TESTS the whole suite skips so plain
// `yarn test` stays offline. Set STEP_THROUGH=1 to pause before each
// test (after the first) until you hit Enter in the terminal.
//
// Deliberately EVM-free: the request exists to be SIGNED, never broadcast.
// The fakenet's own Schnorr attestation only follows a broadcast it observed
// on the target chain, so the in-circuit verification leg is driven with an
// attestation signed from the suite's shared MPC_ROOT_KEY — the same key
// material the fakenet signs with.

import {
  asciiPadded,
  calculateRequestId,
  deriveEvmAddress,
  deriveJubjubKeypair,
  hexToBytes,
  pureCircuits as signetCircuits,
  requestIdBytes,
  requestIdHex,
  schnorrSign,
  sleepUnlessAborted,
  stripHexPrefix,
  toSignBidirectionalRequestIndex,
  SIGNET_DEFAULT_KEY_VERSION,
  type RequestIdHex,
} from "@sig-net/midnight";
import { signBidirectionalRequestToSignedEVMTransaction } from "@sig-net/midnight";
import { ledger as callerContractLedger } from "@midnight-protocol/caller-contract";
import { getAddress } from "ethers";
import { afterAll, describe, expect, it } from "vitest";
import { createCallerE2eSession, type CallerContext } from "../src/caller-session.ts";
import { requireEnv as requireEnvOf } from "../src/e2e-env.ts";
import { injectE2eEnv, installFlowHooks } from "../src/flow-hooks.ts";
import { banner, logSkip } from "../src/output.ts";
import { pollSignetNotification } from "../src/signet-notifications.ts";

const MINUTE = 60_000;

/**
 * The setup-populated env accumulator: repo-root `.env` overlaid with the
 * real environment (which wins), plus every value the caller globalSetup
 * pipeline derived or deployed. Empty when RUN_INTEGRATION_TESTS is unset —
 * the suite below skips before reading it.
 */
const env = injectE2eEnv();

/** Assert a setup step populated `name`, failing with a pointed message. */
const requireEnv = (name: string): string => requireEnvOf(env, name);

// Wallet facade + caller context + MPC-style reader shared by every test in
// this file (lazily built, so the offline path never touches the network);
// stopped once in afterAll.
const session = createCallerE2eSession(env);

// The caller-supplied circuit args of the submit. The nonce is normally the
// derived sender account's chain nonce; with no EVM in this exercise (the
// transaction is signed, never broadcast) any value demonstrates the flow.
const EVM_NONCE = 0n;

// TS mirrors of the contract-fixed request constants in signet-caller.compact
// (the caller package's simulator tests pin the full set; the spec re-checks
// the calldata + path against the LIVE ledger record).
const EXPECTED_SELECTOR = new Uint8Array([0xca, 0x11, 0xab, 0x1e]);
const EXPECTED_WORD = asciiPadded("signet-caller:fixed-word", 32);
const CALLER_PATH = "caller";

/**
 * Read the caller ledger's request-index keys — present request ids as hex.
 *
 * @param context - The session's caller context.
 * @returns The set of request ids currently on the caller's ledger.
 * @throws Error when the contract has no state on-chain.
 */
const readRequestIds = async (context: CallerContext): Promise<Set<RequestIdHex>> => {
  const contractState = await context.providers.publicDataProvider.queryContractState(context.contractAddress);
  if (!contractState) {
    throw new Error(`no contract state found at ${context.contractAddress}`);
  }
  const index = toSignBidirectionalRequestIndex(callerContractLedger(contractState.data).signetRequestsIndex);
  return new Set(index.keys());
};

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("signet-caller generic e2e", () => {
  installFlowHooks();

  afterAll(async () => {
    await session.stop();
  });

  // Populated by the submit test (or CALLER_REQUEST_ID, the resume var for
  // proof-server OOM recovery) for the subsequent stages.
  let signatureRequestId: RequestIdHex;

  it(
    "submitSignatureRequest [signet-caller contract method call]: record a request and read it back MPC-style",
    async () => {
      // Check if a request id was given in the environment (for skipping the
      // heavy submit prove when resuming after a proof-server restart).
      if (env.CALLER_REQUEST_ID) {
        signatureRequestId = env.CALLER_REQUEST_ID as RequestIdHex;
        logSkip("submitSignatureRequest", `CALLER_REQUEST_ID present in environment, skipping submit call '${signatureRequestId}'`);
        return;
      }

      const context = await session.callerContext();

      const before = await readRequestIds(context);
      await context.caller.callTx.submitSignatureRequest(EVM_NONCE, SIGNET_DEFAULT_KEY_VERSION);

      // State indexing lags finalization: poll briefly for the fresh id.
      const deadline = Date.now() + MINUTE;
      let fresh: RequestIdHex[] = [];
      while (fresh.length === 0 && Date.now() < deadline) {
        fresh = [...(await readRequestIds(context))].filter((id) => !before.has(id));
        if (fresh.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      expect(fresh, "the submit must add exactly one request to the caller's ledger").toHaveLength(1);
      signatureRequestId = fresh[0];
      expect(signatureRequestId).toMatch(/^[0-9a-f]{64}$/);

      // MPC-convention verification: fetch the request record the way the
      // response server does — through a SignetRequestResponseReader over RAW
      // contract state — and pin the contract-fixed composition against the
      // LIVE ledger, including the request-id TS-twin lockstep check.
      const record = await session.responseReader().getSignatureRequest(signatureRequestId);
      expect(record.txParams.nonce).toBe(EVM_NONCE);
      expect(record.txParams.chainId).toBe(31337n);
      expect(record.txParams.calldata.is_some).toBe(true);
      expect(record.txParams.calldata.value.selector).toEqual(EXPECTED_SELECTOR);
      expect(record.txParams.calldata.value.words[0]).toEqual(EXPECTED_WORD);
      expect(new TextDecoder().decode(record.path).replace(/\0+$/u, "")).toBe(CALLER_PATH);
      expect(signatureRequestId).toBe(requestIdHex(calculateRequestId(record)));

      banner([
        `Signature request recorded on the caller ledger:`,
        "",
        `  request id: ${signatureRequestId}`,
        "",
        "The response server (fakenet compose service, MIDNIGHT_SIGNET_CONTRACT_ADDRESS set)",
        "polls the signet contract's notification registry and should pick it up",
        "on its next poll — resolving it from THIS caller's ledger — and sign the EVM tx.",
      ]);
    },
    15 * MINUTE,
  );

  it(
    "golden notification: the caller's submit registered a decodable notification in the signet registry",
    async () => {
      // Pins the SignBidirectionalNotification payload layout against a LIVE
      // indexer, read exactly the way the MPC reads it — raw signet state by
      // field position through the hand-composed descriptors. The caller's
      // submit cross-contract-called notifyBidirectionalSignatureRequest to
      // register this.
      expect(signatureRequestId).toBeDefined();
      const callerAddress = requireEnv("MIDNIGHT_CALLER_CONTRACT_ADDRESS");

      const decoded = await pollSignetNotification({
        env,
        requestId: signatureRequestId,
        description: `for request ${signatureRequestId}`,
      });

      // callerAddress points at the caller (the contract whose authenticated
      // ledger holds the request); requestId matches; the index is at field 4
      // (the caller contract's layout, see signet-caller.compact).
      expect(decoded.version).toBe(1);
      expect(decoded.callerAddress).toBe(stripHexPrefix(callerAddress).toLowerCase());
      expect(decoded.requestId).toBe(signatureRequestId);
      expect(decoded.requestsIndexField).toBe(4);

      banner([
        "Golden SignBidirectionalNotification decoded from the live indexer:",
        "",
        `  version:            ${decoded.version}`,
        `  callerAddress:      ${decoded.callerAddress}`,
        `  requestId:          ${decoded.requestId}`,
        `  requestsIndexField: ${decoded.requestsIndexField}`,
      ]);
    },
    2 * MINUTE,
  );

  it(
    "pollSignatureResponse: the MPC's ECDSA response verifies against the caller's derived account",
    async () => {
      expect(signatureRequestId).toBeDefined();

      // The caller's requests are keyed under its contract-fixed path
      // ("caller"), so the MPC signs with the account epsilon-derived from
      // the CALLER CONTRACT's address + that path — recomputed here with the
      // same derivation the MPC uses.
      const expectedSigner = deriveEvmAddress(
        requireEnv("MPC_SECP256K1_PUBKEY"),
        requireEnv("MIDNIGHT_CALLER_CONTRACT_ADDRESS"),
        CALLER_PATH,
      );
      console.log(`expected signer (derived caller account): ${expectedSigner}`);

      // Poll the signet contract's UNAUTHENTICATED response log: every post
      // is judged by whether its signature recovers to the derived sender
      // over the requested transaction's signing hash; the first valid post
      // wins. Rejected posts are immutable log entries — warn each once.
      const reader = session.responseReader();
      const warned = new Set<bigint>();
      const giveUp = new AbortController();
      const timer = setTimeout(() => giveUp.abort(), 2 * MINUTE);
      try {
        while (!giveUp.signal.aborted) {
          const { verified, verdicts } = await reader.getVerifiedSignatureResponse(signatureRequestId, expectedSigner);
          for (const verdict of verdicts) {
            if (verdict.rejectedReason !== undefined && !warned.has(verdict.count)) {
              warned.add(verdict.count);
              console.warn(`ignoring response post ${verdict.count}: ${verdict.rejectedReason}`);
            }
          }
          if (verified !== undefined) {
            // Reconstruct the signed transaction from the request record and
            // the verified response — the typed proof that the MPC's
            // signature answers THIS request from THIS derived account.
            const request = await reader.getSignatureRequest(signatureRequestId);
            const signedTx = signBidirectionalRequestToSignedEVMTransaction(request, verified);
            expect(signedTx.from).toBe(getAddress(expectedSigner));

            banner([
              `MPC signed response for request ${signatureRequestId} found on the signet contract.`,
              "",
              `  signed tx hash: ${signedTx.hash}`,
              `  recovered from: ${signedTx.from}`,
              "",
              "(Nothing is broadcast: this generic exercise ends at the signature.)",
            ]);
            return;
          }
          await sleepUnlessAborted(1000, giveUp.signal);
        }
        throw new Error(`timed out waiting for a valid response to request ${signatureRequestId}`);
      } finally {
        clearTimeout(timer);
      }
    },
    5 * MINUTE,
  );

  it(
    "verifyResponse [signet-caller contract method call]: verify a Schnorr attestation in-circuit and consume the request",
    async () => {
      // The fakenet posts its own Schnorr attestation only after observing
      // the requested transaction on the destination chain — the
      // post-broadcast leg this generic exercise deliberately omits. The
      // caller contract's VERIFICATION of an attestation is what this leg
      // proves, so the attestation is signed here from the suite's shared
      // MPC_ROOT_KEY (the exact key material the fakenet signs with; the
      // setup derived the sealed MPC_JUBJUB_PK from it), using the same
      // compiled circuits the MPC uses.
      expect(signatureRequestId).toBeDefined();

      const context = await session.callerContext();
      const requestKey = requestIdBytes(signatureRequestId);

      // Rerun against a kept contract address: if a prior run already
      // verified this request the entry is gone and verifyResponse would
      // reject with "Request not found" — skip cleanly instead.
      if (!(await readRequestIds(context)).has(signatureRequestId)) {
        logSkip("verifyResponse", `request ${signatureRequestId} already verified (not on the ledger)`);
        return;
      }

      // A successful remote execution output: first byte 1, 32 meaningful
      // bytes (one ABI word) — what the MPC posts for a succeeded call.
      const serializedOutput = new Uint8Array(128);
      serializedOutput[0] = 1;
      const outputLen = 32n;

      const mpcKeys = deriveJubjubKeypair(hexToBytes(stripHexPrefix(requireEnv("MPC_ROOT_KEY"))));
      const message = signetCircuits.signetAttestationMessage(requestKey, serializedOutput, outputLen);
      const signature = schnorrSign(mpcKeys.sk, message, (ax, ay, px, py, m) =>
        signetCircuits.schnorrChallenge(ax, ay, px, py, m),
      );

      await context.caller.callTx.verifyResponse(requestKey, {
        serializedOutput,
        outputLen,
        pk: mpcKeys.pk,
        announcement: signature.announcement,
        response: signature.response,
      });

      // The consumption is the observable effect: present before (checked
      // above), absent after — and removal only happens if every in-circuit
      // check (pk hash, Schnorr signature) passed. Poll briefly for the
      // indexer to catch up.
      const deadline = Date.now() + MINUTE;
      let stillPresent = true;
      while (stillPresent && Date.now() < deadline) {
        stillPresent = (await readRequestIds(context)).has(signatureRequestId);
        if (stillPresent) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      expect(stillPresent, "verifyResponse must consume the request from the ledger").toBe(false);

      banner([
        `Request ${signatureRequestId} verified and consumed.`,
        "",
        "The caller verified the MPC-keyed Schnorr attestation in-circuit and",
        "removed the request from its ledger.",
      ]);
    },
    15 * MINUTE,
  );
});
