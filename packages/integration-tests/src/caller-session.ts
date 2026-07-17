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
  CALLER_PRIVATE_STATE_ID,
  type CallerPrivateState,
  type CallerProviders,
  type Contract as CallerContract,
} from "@midnight-protocol/caller-contract";
import { SignetRequestResponseReader } from "@sig-net/midnight";
import {
  deriveAccountKeys,
  getDeployConfig,
  getMidnightNodeConfig,
  initialiseWalletFacade,
  type WalletFacade,
} from "@sig-net/midnight-contract-deploy";

import { requireEnv } from "./e2e-env.ts";

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
  /** The shared MPC-style request/response reader; see {@link createCallerE2eSession}. */
  responseReader(): SignetRequestResponseReader;
  /** Stop the wallet facade (call from afterAll); safe when never started. */
  stop(): Promise<void>;
}

/**
 * Create the flow file's session. The wallet is the DEPLOYER's (the caller
 * contract involves no user identity, so the requester wallet is purely a
 * fee-paying detail); it is built lazily on first use — joining needs the
 * caller contract deployed, so this can only run once globalSetup has
 * populated env — and stopped once via stop(). Each access re-awaits synced
 * state so long tests / STEP_THROUGH pauses can't hand out a stale wallet.
 *
 * @param env - The setup-populated env accumulator.
 * @returns The session.
 */
export function createCallerE2eSession(env: NodeJS.ProcessEnv): CallerE2eSession {
  let sharedWallet: { facade: WalletFacade; context: CallerContext } | undefined;

  // MPC-style reader over the caller (requester) / signet contract pair,
  // built lazily on first use. Backed by a fresh indexerPublicDataProvider so
  // it reads RAW ledger state exactly as the response server does; it caches
  // fetched request records, so repeated lookups across tests cost one query
  // each.
  let sharedReader: SignetRequestResponseReader | undefined;

  return {
    async callerContext(): Promise<CallerContext> {
      if (!sharedWallet) {
        const deployConfig = getDeployConfig(env);
        setNetworkId(deployConfig.midnightNodeConfig.networkId);
        const keys = deriveAccountKeys(deployConfig.deployerSeed, deployConfig.midnightNodeConfig.networkId);
        const facade = await initialiseWalletFacade(keys, deployConfig.midnightNodeConfig);
        await facade.start(keys.shieldedSecretKeys, keys.dustSecretKey);
        await facade.waitForSyncedState();

        const contractAddress = requireEnv(env, "MIDNIGHT_CALLER_CONTRACT_ADDRESS");
        const providers = buildCallerProviders(facade, keys, deployConfig.midnightNodeConfig);
        const caller = await findDeployedContract(providers, {
          contractAddress,
          compiledContract: callerCompiledContract,
          privateStateId: CALLER_PRIVATE_STATE_ID,
          initialPrivateState: createCallerPrivateState(),
        });
        sharedWallet = { facade, context: { providers, caller, contractAddress } };
      }
      await sharedWallet.facade.waitForSyncedState();
      return sharedWallet.context;
    },

    responseReader(): SignetRequestResponseReader {
      if (!sharedReader) {
        const nodeConfig = getMidnightNodeConfig(env);
        sharedReader = new SignetRequestResponseReader({
          requesterContractAddress: requireEnv(env, "MIDNIGHT_CALLER_CONTRACT_ADDRESS"),
          signetContractAddress: requireEnv(env, "MIDNIGHT_SIGNET_CONTRACT_ADDRESS"),
          publicDataProvider: indexerPublicDataProvider({
            queryURL: nodeConfig.indexerUrl,
            subscriptionURL: nodeConfig.indexerWsUrl,
          }),
        });
      }
      return sharedReader;
    },

    async stop(): Promise<void> {
      await sharedWallet?.facade.stop().catch(() => { });
    },
  };
}
