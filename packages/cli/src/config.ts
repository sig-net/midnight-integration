// CLI configuration — composes the shared Midnight node config from
// @sig-net/midnight-contract-deploy with the CLI-specific environment: the user's
// wallet seed + vault identity secret, the deployed contract addresses, and
// the EVM chain the vault operates on. This is the ONLY file in the package
// that reads the environment.

import {
  getMidnightNodeConfig,
  parseIdentitySecretKey,
  type MidnightNodeConfig,
} from "@sig-net/midnight-contract-deploy";

// The pre-funded genesis mint wallet of the local standalone stack — the
// documented default when USER_SEED is unset (same convention as the deploy package's
// DEPLOYER_SEED default).
const DEFAULT_USER_SEED = "0000000000000000000000000000000000000000000000000000000000000001";

/**
 * Everything a CLI command needs, resolved once from the environment.
 * Deployment-target fields are optional here so read-only invocations (like
 * `--help`) work without a configured stack; commands that need one narrow
 * with {@link requireConfigValue}.
 */
export interface CliConfig {
  /** Endpoints + network id of the Midnight network to talk to. */
  readonly midnightNodeConfig: MidnightNodeConfig;
  /** The user's wallet seed (hex or mnemonic) paying for Midnight transactions. */
  readonly userSeed: string;
  /**
   * The user's 32-byte vault identity secret — answers the vault's
   * `callerSecretKey` witness; its commitment is the on-ledger identity and
   * the MPC derivation path.
   */
  readonly userSecretKey: Uint8Array;
  /** Address of the deployed ERC20 vault contract on Midnight. */
  readonly vaultContractAddress?: string;
  /** Address of the deployed central signet contract on Midnight. */
  readonly signetContractAddress?: string;
  /** JSON-RPC endpoint of the EVM chain the vault operates on. */
  readonly evmRpcUrl?: string;
  /** Chain id of that EVM chain. */
  readonly evmChainId?: bigint;
  /** CAIP-2 id derived from `evmChainId` (`eip155:<id>`) — the MPC routing key. */
  readonly caip2Id?: string;
  /** Address of the ERC20 token the vault holds (20-byte 0x hex). */
  readonly erc20Address?: string;
  /** Address of the EVM vault account - derived from vaultContractAddress */
  readonly evmVaultAddress?: string;
  /** EVM address of the user's account - dervied from depositing user's committment */
  readonly evmUserAddress?: string;
}

/**
 * Read the {@link CliConfig} from the environment.
 *
 * Midnight endpoints come from the deploy package's `getMidnightNodeConfig` (`NETWORK_ID`,
 * `MIDNIGHT_NODE_*`). CLI-specific variables:
 * - `USER_SEED` — wallet seed (default: the genesis mint wallet of the local stack).
 * - `VAULT_USER_SECRET_KEY` — 32-byte hex identity secret (default: the seed bytes).
 * - `MIDNIGHT_VAULT_CONTRACT_ADDRESS`, `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` — deployed contract addresses.
 * - `EVM_RPC_URL`, `EVM_CHAIN_ID`, `ERC20_ADDRESS` — the EVM side.
 *
 * @param env - The environment to read from.
 * @returns The resolved configuration.
 * @throws If `EVM_CHAIN_ID` is not a positive integer, `ERC20_ADDRESS` is not
 * a 20-byte 0x hex address, or the identity secret/seed is malformed.
 */
export function getCliConfig(env: Record<string, string | undefined> = process.env): CliConfig {
  const userSeed = env.USER_SEED?.trim() || DEFAULT_USER_SEED;
  const userSecretKey = parseIdentitySecretKey("VAULT_USER_SECRET_KEY", env, userSeed);

  const evmChainIdRaw = env.EVM_CHAIN_ID?.trim();
  if (evmChainIdRaw !== undefined && evmChainIdRaw !== "" && !/^\d+$/.test(evmChainIdRaw)) {
    throw new Error(`EVM_CHAIN_ID must be a positive integer; got "${evmChainIdRaw}".`);
  }
  const evmChainId = evmChainIdRaw ? BigInt(evmChainIdRaw) : undefined;

  const erc20Address = env.ERC20_ADDRESS?.trim() || undefined;
  if (erc20Address !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(erc20Address)) {
    throw new Error(`ERC20_ADDRESS must be a 20-byte 0x hex address; got "${erc20Address}".`);
  }

  return {
    midnightNodeConfig: getMidnightNodeConfig(env),
    userSeed,
    userSecretKey,
    vaultContractAddress: env.MIDNIGHT_VAULT_CONTRACT_ADDRESS?.trim() || undefined,
    signetContractAddress: env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS?.trim() || undefined,
    evmRpcUrl: env.EVM_RPC_URL?.trim() || undefined,
    evmChainId,
    caip2Id: evmChainId === undefined ? undefined : `eip155:${evmChainId}`,
    erc20Address,
    evmVaultAddress: env.EVM_VAULT_ADDRESS?.trim() || undefined,
    evmUserAddress: env.EVM_USER_ADDRESS?.trim() || undefined,
  };
}

/**
 * Narrow an optional {@link CliConfig} field to required, failing with the
 * environment variable to set when it is absent.
 *
 * @param value - The optional config value.
 * @param envVar - The environment variable that supplies it.
 * @returns The value, now known to be present.
 * @throws If the value is undefined.
 */
export function requireConfigValue<T>(value: T | undefined, envVar: string): T {
  if (value === undefined) {
    throw new Error(`${envVar} must be set for this command.`);
  }
  return value;
}
