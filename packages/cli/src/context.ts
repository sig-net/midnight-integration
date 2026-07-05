// The connected runtime a command needs beyond plain config: the indexer
// public-data provider and the joined vault contract handle. Constructed once
// in main.ts and handed to commands the same way config is.
//
// Every getter is LAZY (and cached), so command parsing, validation, and
// `--help` never touch the network. Today the getters are also the stub
// boundary: each throws NotImplementedError naming the wiring it is waiting
// on. Wiring plan: lib grows a midnight-js provider builder (indexer /
// proof-server / private-state store / WalletFacade adapted as
// balancer+submitter); `vault()` then becomes
// `findDeployedContract(providers, { contractAddress, compiledContract,
// privateStateId, initialPrivateState })` with the vault's witnesses and the
// configured identity as private state — and `callTx.<circuit>(...)` on the
// returned handle balances, proves, and submits, coin-bearing calls included.

import type { FoundContract } from "@midnight-ntwrk/midnight-js/contracts";
import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js/types";

import type { Contract, VaultPrivateState } from "@midnight-erc20-vault/vault-contract";

import type { CliConfig } from "./config.ts";
import { NotImplementedError } from "./errors.ts";

/**
 * The joined vault contract handle — midnight-js's found-contract shape typed
 * to the vault's generated contract, so `callTx.initialize(...)` /
 * `callTx.requestDeposit(...)` carry the real circuit signatures.
 */
export type DeployedVaultContract = FoundContract<Contract<VaultPrivateState>>;

/**
 * Everything a command may need: the resolved config plus lazy access to the
 * connected resources. Commands receive this instead of raw config; they must
 * never construct providers, wallets, or contract handles themselves.
 */
export interface CliContext {
  /** The resolved CLI configuration. */
  readonly config: CliConfig;
  /**
   * The indexer-backed public data provider — raw contract state queries, no
   * wallet or proving keys involved.
   *
   * @throws NotImplementedError — the provider builder does not exist in
   * @midnight-erc20-vault/lib yet.
   */
  publicDataProvider(): Promise<PublicDataProvider>;
  /**
   * The vault contract at `VAULT_CONTRACT_ADDRESS`, joined with the vault's
   * witnesses and the configured identity as private state. Building it
   * implies wallet construction and sync — expect the first call to be slow.
   *
   * @throws NotImplementedError — provider + wallet-adapter wiring does not
   * exist in @midnight-erc20-vault/lib yet.
   */
  vault(): Promise<DeployedVaultContract>;
}

/**
 * Build the {@link CliContext} for one command invocation. Cheap and
 * side-effect free: all connections happen lazily inside the getters.
 *
 * @param config - The resolved CLI configuration.
 * @returns The context to hand to a command function.
 */
export function createCliContext(config: CliConfig): CliContext {
  return {
    config,
    async publicDataProvider(): Promise<PublicDataProvider> {
      throw new NotImplementedError(
        "the indexer public-data provider builder does not exist in @midnight-erc20-vault/lib yet",
      );
    },
    async vault(): Promise<DeployedVaultContract> {
      throw new NotImplementedError(
        "joining the deployed vault (midnight-js providers + wallet adapter + findDeployedContract) " +
          "is not wired in @midnight-erc20-vault/lib yet",
      );
    },
  };
}
