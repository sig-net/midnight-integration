// The connected client context: config + the vault providers + the JOINED
// vault contract handle. Built once per command invocation (inside a synced
// wallet session) and handed to commands the same way config is. The pieces
// come from where they belong: generic wallet construction from
// @midnight-erc20-vault/lib (as in vault-contract's deploy.ts), the
// vault-specific providers / witnesses / compiled-contract binding from the
// vault package itself — the "SDK" generated from the contract.

import { findDeployedContract, type FoundContract } from "@midnight-ntwrk/midnight-js/contracts";
// midnight-js reads a process-global network id (unlike compact-js, which
// takes it explicitly). createCliContext sets it once per invocation.
import { setNetworkId } from "@midnight-ntwrk/midnight-js/network-id";

import type { AccountKeys, WalletFacade } from "@midnight-erc20-vault/lib";
import {
  buildVaultProviders,
  createVaultPrivateState,
  vaultCompiledContract,
  VAULT_PRIVATE_STATE_ID,
  type Contract as VaultContract,
  type VaultPrivateState,
  type VaultProviders,
} from "@midnight-erc20-vault/vault-contract";

import { requireConfigValue, type CliConfig } from "./config.ts";

/**
 * The joined vault contract handle — midnight-js's found-contract shape typed
 * to the vault's generated contract, so `callTx.initialize(...)` /
 * `callTx.requestDeposit(...)` carry the real circuit signatures.
 */
export type DeployedVaultContract = FoundContract<VaultContract<VaultPrivateState>>;

/** The started wallet a context is built around: facade + its key material. */
export interface CliWallet {
  /** A started (and synced) wallet facade — pays for and submits transactions. */
  readonly facade: WalletFacade;
  /** The key material of the same wallet, for balancing and signing. */
  readonly keys: AccountKeys;
}

/**
 * Everything a command needs: the resolved config, the vault's midnight-js
 * providers, and the joined vault contract. Commands receive this instead of
 * raw config; they never construct providers, wallets, or contract handles
 * themselves.
 */
export interface CliContext {
  /** The resolved CLI configuration. */
  readonly config: CliConfig;
  /** The vault's provider set (public data / proof / zk-config / private state / wallet). */
  readonly providers: VaultProviders;
  /** The vault at `MIDNIGHT_VAULT_CONTRACT_ADDRESS`, joined with witnesses + the configured identity. */
  readonly vault: DeployedVaultContract;
}

/**
 * Build the {@link CliContext}: set the midnight-js network id, build the
 * vault's providers around the wallet, and join the deployed vault contract
 * with the configured identity as private state.
 *
 * @param config - The resolved CLI configuration.
 * @param wallet - The started wallet (main.ts opens it via lib's `withSyncedWalletFacade`).
 * @returns The context to hand to a command function.
 * @throws If `MIDNIGHT_VAULT_CONTRACT_ADDRESS` is unset or no contract answers there.
 */
export async function createCliContext(config: CliConfig, wallet: CliWallet): Promise<CliContext> {
  setNetworkId(config.midnightNodeConfig.networkId);

  const vaultContractAddress = requireConfigValue(config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");
  const providers = buildVaultProviders(wallet.facade, wallet.keys, config.midnightNodeConfig);

  const vault = await findDeployedContract(providers, {
    contractAddress: vaultContractAddress,
    compiledContract: vaultCompiledContract,
    privateStateId: VAULT_PRIVATE_STATE_ID,
    initialPrivateState: createVaultPrivateState(config.userSecretKey),
  });

  return { config, providers, vault };
}

