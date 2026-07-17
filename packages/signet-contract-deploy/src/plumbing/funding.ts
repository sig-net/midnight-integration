// Account funding primitives for the root-funds-children model. Fees are paid
// in DUST, which only generates on NIGHT registered for dust generation, so a
// wallet is fee-ready only once it holds NIGHT that is registered and has
// generated spendable dust. One ROOT wallet (the local genesis mint, or a
// faucet-funded seed on a deployed network) holds the funds and pays out to
// the role wallets (deployer, invoker, mpc responder); the roles themselves
// are generated per environment and topped up from root.
//
// These are mechanical primitives (read a balance, assert root is funded,
// fund one child). The pipeline that resolves/persists seeds, decides the
// per-child amount, and prints addresses lives in the integration-tests setup.

import type { MidnightNodeConfig } from "./midnight-node-config.ts";
import {
  deriveAccountKeys,
  deriveAddresses,
  registerNightForDustGeneration,
  transferNight,
  waitForSpendableDust,
  withSyncedWalletFacade,
  type FacadeState,
  type WalletAddresses,
} from "./wallet.ts";

/** A wallet's synced funding snapshot: its addresses and NIGHT/DUST balances (base units). */
export interface AccountFunding {
  /** The wallet's three bech32m addresses (network-prefixed). */
  readonly addresses: WalletAddresses;
  /** Total unshielded NIGHT held, in base units. */
  readonly night: bigint;
  /** Spendable DUST (fee) balance right now, in base units. */
  readonly dust: bigint;
}

/** Sum a wallet's unshielded NIGHT across its UTXOs, in base units. */
function totalNight(state: FacadeState): bigint {
  return Object.values(state.unshielded.balances).reduce((sum, value) => sum + value, 0n);
}

/**
 * Derive a seed's three addresses without any network I/O. Convenience for
 * printing a wallet's addresses before (or without) syncing it.
 *
 * @param seed - The wallet seed (hex or mnemonic).
 * @param config - The stack whose network id prefixes the addresses.
 * @returns The wallet's unshielded / shielded / dust addresses.
 */
export function deriveWalletAddresses(seed: string, config: MidnightNodeConfig): WalletAddresses {
  return deriveAddresses(deriveAccountKeys(seed, config.networkId), config.networkId);
}

/**
 * Sync a wallet and read its funding snapshot (addresses + NIGHT + DUST).
 *
 * @param config - The stack the wallet connects to.
 * @param seed - The wallet seed (hex or mnemonic).
 * @returns The synced {@link AccountFunding}.
 */
export async function readAccountFunding(config: MidnightNodeConfig, seed: string): Promise<AccountFunding> {
  const keys = deriveAccountKeys(seed, config.networkId);
  const addresses = deriveAddresses(keys, config.networkId);
  return withSyncedWalletFacade(keys, config, async (_facade, state) => ({
    addresses,
    night: totalNight(state),
    dust: state.dust.balance(new Date()),
  }));
}

/** A wallet is fee-ready when it holds NIGHT and that NIGHT has generated spendable dust. */
export function isFeeReady(funding: AccountFunding): boolean {
  return funding.night > 0n && funding.dust > 0n;
}

/**
 * The root wallet holds no funds on a deployed network until its NIGHT
 * receive address is faucet-funded. Thrown by {@link assertRootFunded} so the
 * setup pipeline can STOP with the exact address and faucet URL to act on.
 */
export class RootUnfundedError extends Error {
  constructor(
    readonly nightAddress: string,
    readonly faucetUrl: string | undefined,
  ) {
    const where = faucetUrl ? `at ${faucetUrl}` : "via the network's faucet";
    super(
      `root wallet holds no NIGHT. Fund it ${where}, then rerun.\n` +
        `  NIGHT address: ${nightAddress}` +
        (faucetUrl ? `\n  faucet:        ${faucetUrl}` : ""),
    );
    this.name = "RootUnfundedError";
  }
}

/**
 * Ensure the root wallet is fee-ready, returning its snapshot. Root holds no
 * NIGHT on a deployed network before faucet funding, so this throws
 * {@link RootUnfundedError} (NIGHT address + faucet URL) when NIGHT is zero.
 * Otherwise it registers root's NIGHT for dust generation and waits for a
 * spendable DUST balance, because root pays the children's funding transfers
 * in DUST: the local genesis root is already registered (a no-op here), but a
 * faucet-funded root is not, and would have no DUST to spend.
 *
 * @param config - The stack the root wallet connects to.
 * @param rootSeed - The root wallet seed.
 * @param faucetUrl - The network's faucet URL for the underfunded message.
 * @returns The root's fee-ready funding snapshot.
 * @throws {@link RootUnfundedError} if root holds no NIGHT; or if no dust
 *   appears in time after registration.
 */
export async function assertRootFunded(
  config: MidnightNodeConfig,
  rootSeed: string,
  faucetUrl: string | undefined,
): Promise<AccountFunding> {
  const keys = deriveAccountKeys(rootSeed, config.networkId);
  const addresses = deriveAddresses(keys, config.networkId);
  return withSyncedWalletFacade(keys, config, async (facade, state) => {
    const night = totalNight(state);
    if (night === 0n) {
      throw new RootUnfundedError(addresses.unshielded, faucetUrl);
    }
    await registerNightForDustGeneration(facade, keys, state);
    const dustNow = state.dust.balance(new Date());
    const dust = dustNow > 0n ? dustNow : await waitForSpendableDust(facade);
    return { addresses, night, dust };
  });
}

/**
 * Bring one child wallet to fee-ready by topping it up from root: if it holds
 * no NIGHT, transfer `amount` from root and wait for the child to see it; then
 * register the child's NIGHT for dust generation and wait for spendable dust.
 * A child that already holds NIGHT but no dust yet is only registered + waited
 * (no transfer). Call only for a child that is not already fee-ready.
 *
 * @param config - The stack both wallets connect to.
 * @param rootSeed - The funding wallet's seed.
 * @param childSeed - The child wallet's seed.
 * @param amount - NIGHT to transfer when the child holds none, in base units.
 * @returns The child's post-funding snapshot.
 * @throws If root cannot cover the transfer, or dust never appears in time.
 */
export async function fundChildFromRoot(
  config: MidnightNodeConfig,
  rootSeed: string,
  childSeed: string,
  amount: bigint,
): Promise<AccountFunding> {
  const rootKeys = deriveAccountKeys(rootSeed, config.networkId);
  const childKeys = deriveAccountKeys(childSeed, config.networkId);
  const childAddresses = deriveAddresses(childKeys, config.networkId);

  const before = await withSyncedWalletFacade(childKeys, config, async (_f, s) => totalNight(s));

  if (before === 0n) {
    await withSyncedWalletFacade(rootKeys, config, async (rootFacade, rootState) => {
      await transferNight(rootFacade, rootKeys, rootState, childAddresses.unshielded, config.networkId, amount);
    });
  }

  return withSyncedWalletFacade(childKeys, config, async (childFacade, childState) => {
    // Wait for the transferred NIGHT UTXO to land in the child's synced view.
    let state = childState;
    for (let i = 0; i < 40 && totalNight(state) === 0n; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      state = await childFacade.waitForSyncedState();
    }
    if (totalNight(state) === 0n) {
      throw new Error(`child wallet ${childAddresses.unshielded} shows no NIGHT after funding from root`);
    }
    await registerNightForDustGeneration(childFacade, childKeys, state);
    const dust = await waitForSpendableDust(childFacade);
    return { addresses: childAddresses, night: totalNight(state), dust };
  });
}
