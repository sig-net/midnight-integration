// Per-flow-file wallet + reader lifecycle. Each flow test file creates ONE
// session at module scope, uses it lazily from its tests, and stops it in
// afterAll. Files run in separate workers (vitest.config.ts serializes them),
// so a session never crosses files — the lazy construction keeps the offline
// path (RUN_INTEGRATION_TESTS unset) from ever touching the network.

import { createCliContext, getCliConfig, type CliContext } from "@midnight-erc20-vault/cli";
import { deriveAccountKeys, getMidnightNodeConfig, initialiseWalletFacade, type WalletFacade } from "@midnight-erc20-vault/lib";
import { SignetRequestResponseReader } from "@midnight-erc20-vault/signet-midnight";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { requireEnv } from "./e2e-env.ts";

export interface E2eSession {
  /** The shared wallet-backed cli context; see createE2eSession. */
  cliContext(): Promise<CliContext>;
  /** The shared MPC-style request/response reader; see createE2eSession. */
  responseReader(): SignetRequestResponseReader;
  /** Stop the wallet facade (call from afterAll); safe when never started. */
  stop(): Promise<void>;
}

export function createE2eSession(env: NodeJS.ProcessEnv): E2eSession {
  // Wallet facade + cli context shared by every test in the flow file. Built
  // lazily on first use — createCliContext needs the vault contract deployed,
  // so this can only run once globalSetup has populated env — and stopped once
  // via stop(). Each access re-awaits synced state (instant when already
  // synced) so long tests / STEP_THROUGH pauses can't hand out a stale wallet.
  let sharedWallet: { facade: WalletFacade; context: CliContext } | undefined;

  // MPC-style reader over the vault (requester) / signet contract pair, built
  // lazily on first use. Backed by a fresh indexerPublicDataProvider so it
  // reads RAW ledger state exactly as the response server does; it caches
  // fetched request records, so repeated lookups across tests cost one query
  // each.
  let sharedReader: SignetRequestResponseReader | undefined;

  return {
    async cliContext(): Promise<CliContext> {
      if (!sharedWallet) {
        const config = getCliConfig(env);
        const keys = deriveAccountKeys(config.userSeed, config.midnightNodeConfig.networkId);
        const facade = await initialiseWalletFacade(keys, config.midnightNodeConfig);
        await facade.start(keys.shieldedSecretKeys, keys.dustSecretKey);
        await facade.waitForSyncedState();
        sharedWallet = { facade, context: await createCliContext(config, { facade, keys }) };
      }
      await sharedWallet.facade.waitForSyncedState();
      return sharedWallet.context;
    },

    responseReader(): SignetRequestResponseReader {
      if (!sharedReader) {
        const nodeConfig = getMidnightNodeConfig(env);
        sharedReader = new SignetRequestResponseReader({
          requesterContractAddress: requireEnv(env, "MIDNIGHT_VAULT_CONTRACT_ADDRESS"),
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
