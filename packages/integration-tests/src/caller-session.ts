// Per-flow-file wallet + reader lifecycle for the generic signet-caller e2e —
// the caller-shaped sibling of session.ts. The flow file creates ONE session
// at module scope, uses it lazily from its tests, and stops it in afterAll.
// The lazy construction keeps the offline path (RUN_INTEGRATION_TESTS unset)
// from ever touching the network.

import { findDeployedContract, type FoundContract } from "@midnight-ntwrk/midnight-js/contracts";
// midnight-js reads a process-global network id (unlike compact-js, which
// takes it explicitly). The context builder sets it once per session.
import { setNetworkId } from "@midnight-ntwrk/midnight-js/network-id";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";

import {
  buildCallerProviders,
  callerCompiledContract,
  createCallerPrivateState,
  ledger as callerContractLedger,
  CALLER_PRIVATE_STATE_ID,
  type CallerPrivateState,
  type CallerProviders,
  type Contract as CallerContract,
} from "@midnight-protocol/test-caller-contract";
import {
  hexToBytes,
  signetEventSourceFromPublicDataProvider,
  stripHexPrefix,
  toSignBidirectionalEventIndex,
  SignetRequestResponseReader,
  type RequestIdHex,
  type Secp256k1Point,
} from "@sig-net/midnight";
import {
  deriveAccountKeys,
  getMidnightNodeConfig,
  initialiseWalletFacade,
  type WalletFacade,
} from "@sig-net/midnight-contract-deploy";
import { expect } from "vitest";

import { requireEnv } from "./e2e-env.ts";
import { logSkip } from "./output.ts";

/**
 * The joined caller contract handle — midnight-js's found-contract shape
 * typed to the caller's generated contract, so
 * `callTx.submitSignatureRequest(...)` / `callTx.verifyResponse(...)` carry
 * the real circuit signatures.
 */
export type DeployedCallerContract = FoundContract<CallerContract<CallerPrivateState>>;

/**
 * Everything a caller flow test needs: the caller's midnight-js providers and
 * the joined caller contract at `MIDNIGHT_CALLER_CONTRACT_ADDRESS`.
 */
export interface CallerContext {
  /** The caller's provider set (public data / proof / zk-config / private state / wallet). */
  readonly providers: CallerProviders;
  /** The caller contract, joined with its (empty) private state. */
  readonly caller: DeployedCallerContract;
  /** The joined contract's Midnight address. */
  readonly contractAddress: string;
}

/** The lazily-built shared state of one caller e2e flow file. */
export interface CallerE2eSession {
  /** The shared wallet-backed caller context; see {@link createCallerE2eSession}. */
  callerContext(): Promise<CallerContext>;
  /**
   * The shared MPC-style request/response reader for one of the caller's
   * request maps; see {@link createCallerE2eSession}. The caller contract
   * keeps one map per schema width, so the reader is keyed by the map's
   * ledger field position (default 4, the bool-schema map).
   */
  responseReader(requestsIndexField?: number): SignetRequestResponseReader;
  /** Stop the wallet facade (call from afterAll); safe when never started. */
  stop(): Promise<void>;
}

/**
 * Create the flow file's session. The wallet is the INVOKER's (the caller
 * contract involves no user identity, so the requester wallet is purely a
 * fee-paying detail; the invoker is a role wallet funded from root by the
 * setup); it is built lazily on first use — joining needs the caller contract
 * deployed, so this can only run once globalSetup has populated env — and
 * stopped once via stop(). Each access re-awaits synced state so long tests /
 * STEP_THROUGH pauses can't hand out a stale wallet.
 *
 * @param env - The setup-populated env accumulator.
 * @returns The session.
 */
export function createCallerE2eSession(env: NodeJS.ProcessEnv): CallerE2eSession {
  let sharedWallet: { facade: WalletFacade; context: CallerContext } | undefined;

  // MPC-style readers over the caller (requester) / signet contract pair,
  // built lazily on first use and keyed by the request map's ledger field
  // position (the caller keeps one map per schema width). Backed by a fresh
  // indexerPublicDataProvider so they read RAW ledger state exactly as the
  // response server does; each caches fetched request records, so repeated
  // lookups across tests cost one query each.
  const sharedReaders = new Map<number, SignetRequestResponseReader>();

  return {
    async callerContext(): Promise<CallerContext> {
      if (!sharedWallet) {
        const nodeConfig = getMidnightNodeConfig(env);
        setNetworkId(nodeConfig.networkId);
        const keys = deriveAccountKeys(requireEnv(env, "INVOKER_SEED"), nodeConfig.networkId);
        const facade = await initialiseWalletFacade(keys, nodeConfig);
        await facade.start(keys.shieldedSecretKeys, keys.dustSecretKey);
        await facade.waitForSyncedState();

        const contractAddress = requireEnv(env, "MIDNIGHT_CALLER_CONTRACT_ADDRESS");
        const providers = buildCallerProviders(facade, keys, nodeConfig);
        // The private state carries the deployer identity secret feeding the
        // deployerSecretKey witness: initialise is deployer-gated. The store
        // is contract-address-scoped, so a fresh deploy always takes this
        // initial state (no stale-state hazard across redeploys).
        const privateState = createCallerPrivateState(
          hexToBytes(stripHexPrefix(requireEnv(env, "CALLER_DEPLOYER_SECRET_KEY"))),
        );
        const caller = await findDeployedContract(providers, {
          contractAddress,
          compiledContract: callerCompiledContract,
          privateStateId: CALLER_PRIVATE_STATE_ID,
          initialPrivateState: privateState,
        });
        sharedWallet = { facade, context: { providers, caller, contractAddress } };
      }
      await sharedWallet.facade.waitForSyncedState();
      return sharedWallet.context;
    },

    // Default field 4: the bool-schema map every submit circuit's
    // notification names except submitCheckAndDoubleRequest's (field 7).
    responseReader(requestsIndexField = 4): SignetRequestResponseReader {
      let reader = sharedReaders.get(requestsIndexField);
      if (!reader) {
        const nodeConfig = getMidnightNodeConfig(env);
        const publicDataProvider = indexerPublicDataProvider({
          queryURL: nodeConfig.indexerUrl,
          subscriptionURL: nodeConfig.indexerWsUrl,
        });
        reader = new SignetRequestResponseReader({
          requesterContractAddress: requireEnv(env, "MIDNIGHT_CALLER_CONTRACT_ADDRESS"),
          // The caller contract is flat, so a field number is a depth-1 path.
          requesterRequestsPath: [requestsIndexField],
          signetContractAddress: requireEnv(env, "MIDNIGHT_SIGNET_CONTRACT_ADDRESS"),
          publicDataProvider,
          // The MPC's responses are read from the contract events the
          // signet contract emits, through the same provider.
          eventSource: signetEventSourceFromPublicDataProvider(publicDataProvider),
        });
        sharedReaders.set(requestsIndexField, reader);
      }
      return reader;
    },

    async stop(): Promise<void> {
      await sharedWallet?.facade.stop().catch(() => { });
    },
  };
}

// Both flow files share the polling cadence below.
const MINUTE = 60_000;

/**
 * The per-schema-width request maps the caller contract keeps: the generic
 * flow only touches the default `signBidirectionalEventMap`, the EVM flow
 * also drives the 69-byte-schema map.
 */
export type CallerRequestMap = "signBidirectionalEventMap" | "signBidirectionalEventMap69";

/**
 * Read one caller request map's keys, presented as hex request ids.
 *
 * @param context - The session's caller context.
 * @param map - Which per-width map to read (default: the bool-schema map).
 * @returns The set of request ids currently in that map.
 * @throws Error when the contract has no state on-chain.
 */
export async function readCallerRequestIds(
  context: CallerContext,
  map: CallerRequestMap = "signBidirectionalEventMap",
): Promise<Set<RequestIdHex>> {
  const contractState = await context.providers.publicDataProvider.queryContractState(context.contractAddress);
  if (!contractState) {
    throw new Error(`no contract state found at ${context.contractAddress}`);
  }
  return new Set(toSignBidirectionalEventIndex(callerContractLedger(contractState.data)[map]).keys());
}

/**
 * The idempotent initialise stage both flow files run: store the caller
 * contract's MPC response key via the one-shot initialise circuit, or (on a
 * rerun against a kept caller) check the already-stored key against the
 * expected one and skip the call. The response key is derived from the
 * CALLER's own address after deploy, so it cannot be a constructor argument.
 *
 * @param context - The session's caller context.
 * @param mpcResponseKey - The expected MPC response key (parsed point).
 * @returns "stored" when this call ran initialise, "already-stored" on the
 *   idempotent skip path.
 */
export async function ensureMpcResponseKeyStored(
  context: CallerContext,
  mpcResponseKey: Secp256k1Point,
): Promise<"stored" | "already-stored"> {
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
    logSkip("initialise", "the MPC response key is already stored (rerun against a kept caller)");
    return "already-stored";
  }

  await context.caller.callTx.initialise(mpcResponseKey);

  // State indexing lags finalization: poll briefly for the store.
  const deadline = Date.now() + MINUTE;
  let current = await readKeyState();
  while (current.initialised === 0n && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    current = await readKeyState();
  }
  expect(current.initialised, "initialise must flip the sentinel").toBe(1n);
  expect(current.storedKey, "initialise must store MPC_RESPONSE_KEY verbatim").toEqual(mpcResponseKey);
  return "stored";
}
