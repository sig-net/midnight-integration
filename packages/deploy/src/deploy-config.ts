// Deploy utility config — everything needed to perform a contract deploy:
// which stack to target, and which wallet pays for it.

import { getMidnightNodeConfig, type MidnightNodeConfig } from "@midnight-erc20-vault/lib";

export interface DeployConfig {
  readonly midnightNodeConfig: MidnightNodeConfig; // the stack to deploy to
  readonly deployerSeed: string; // wallet that funds & signs the deploy
}

// Pre-funded genesis wallet of the local standalone stack — the default
// deployer for development.
const GENESIS_MINT_WALLET_SEED = "0000000000000000000000000000000000000000000000000000000000000001";

/**
 * Read a {@link DeployConfig} from the environment. Every variable is
 * optional: node config per {@link getMidnightNodeConfig}, plus
 * `DEPLOYER_SEED` (hex or mnemonic) defaulting to the genesis mint wallet.
 */
export function getDeployConfig(
  env: Record<string, string | undefined> = process.env,
): DeployConfig {
  return {
    midnightNodeConfig: getMidnightNodeConfig(env),
    deployerSeed: env.DEPLOYER_SEED?.trim() || GENESIS_MINT_WALLET_SEED,
  }
}