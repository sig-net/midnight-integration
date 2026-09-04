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
import { isLocalStandaloneNetwork, type NetworkId } from "./network-id.ts";
import {
  type AccountKeys,
  deriveAccountKeys,
  deriveAddresses,
  type FacadeState,
  registerNightForDustGeneration,
  transferNight,
  waitForSpendableDust,
  type WalletAddresses,
  type WalletFacade,
  withSyncedWalletFacade,
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

/**
 * Sum a wallet's unshielded NIGHT across its UTXOs, in base units.
 *
 * @param state - The synced wallet facade state to total.
 * @returns The wallet's total unshielded NIGHT in base units.
 */
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
export async function readAccountFunding(
  config: MidnightNodeConfig,
  seed: string,
): Promise<AccountFunding> {
  const keys = deriveAccountKeys(seed, config.networkId);
  const addresses = deriveAddresses(keys, config.networkId);
  return withSyncedWalletFacade(keys, config, (_facade, state) =>
    Promise.resolve({
      addresses,
      night: totalNight(state),
      dust: state.dust.balance(new Date()),
    }),
  );
}

/**
 * A wallet is fee-ready when it holds NIGHT and that NIGHT has generated spendable dust.
 *
 * @param funding - The wallet's measured funding.
 * @returns Whether the wallet can pay fees right now.
 */
export function isFeeReady(funding: AccountFunding): boolean {
  return funding.night > 0n && funding.dust > 0n;
}

/**
 * Bring one wallet to fee-ready and return its spendable DUST balance. Fees
 * are paid in DUST, which only generates on NIGHT registered for dust
 * generation, so every unregistered NIGHT UTXO the wallet holds is registered
 * here first, whatever its current dust: a faucet top-up or transfer change
 * arrives unregistered, and leaving it so while older dust lasts would let
 * the wallet's dust generation shrink with every spend. Then a wallet with
 * spendable dust returns it, and one without waits until its first dust
 * appears (a few blocks). The facade must be started and synced, and `state`
 * must be its synced state (see `withSyncedWalletFacade` in wallet.ts).
 *
 * @param facade - A started wallet facade for `keys`, which submits the registration.
 * @param keys - The key material of the same wallet. Its keystore signs the registration.
 * @param state - The synced facade state the balances and NIGHT UTXOs are read from.
 * @param networkId - The network the wallet lives on, which prefixes the
 *   NIGHT receive address the no-NIGHT error prints for faucet funding.
 * @param faucetUrl - The network's faucet for the no-NIGHT hint, when one is known.
 * @returns The wallet's spendable DUST balance, always positive.
 * @throws {Error} If the wallet holds neither NIGHT nor DUST (the message
 *   carries the wallet's NIGHT receive address to fund), or no dust appears
 *   in time after registration (see {@link waitForSpendableDust}).
 */
export async function ensureFeeReady(
  facade: WalletFacade,
  keys: AccountKeys,
  state: FacadeState,
  networkId: NetworkId,
  faucetUrl?: string,
): Promise<bigint> {
  const dust = state.dust.balance(new Date());
  if (totalNight(state) === 0n) {
    if (dust > 0n) return dust;
    const { unshielded } = deriveAddresses(keys, networkId);
    const where = faucetUrl ? `at ${faucetUrl}` : "via the network's faucet";
    throw new Error(
      `wallet has no NIGHT and so cannot generate the DUST that pays fees. Fund it ${where}, then retry.\n` +
        `  NIGHT address: ${unshielded}` +
        (faucetUrl ? `\n  faucet:        ${faucetUrl}` : ""),
    );
  }
  const registered = await registerNightForDustGeneration(facade, keys, state);
  if (registered > 0) {
    console.log(`registered ${String(registered)} NIGHT UTXO(s) for dust generation`);
  }
  if (dust > 0n) return dust;
  console.log("waiting for spendable DUST...");
  return waitForSpendableDust(facade);
}

/**
 * The root wallet holds no funds on a deployed network until its NIGHT
 * receive address is faucet-funded. Thrown by {@link assertRootFunded} so the
 * setup pipeline can STOP with the exact address and faucet URL to act on.
 */
export class RootUnfundedError extends Error {
  /**
   * @param nightAddress - The NIGHT receive address that needs funding.
   * @param faucetUrl - The network's faucet, when one is known.
   */
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

// A freshly composed local stack has a window where the indexer reports a
// synced (empty) state before it has indexed the genesis block that funds the
// genesis mint wallet — so a zero root balance there means "not indexed yet",
// not "unfunded". Poll until the genesis funds appear.
const GENESIS_INDEX_POLL_INTERVAL_MS = 3_000;
const GENESIS_INDEX_TIMEOUT_MS = 120_000;

/**
 * Ensure the root wallet is fee-ready, returning its snapshot. Root holds no
 * NIGHT on a deployed network before faucet funding, so this throws
 * {@link RootUnfundedError} (NIGHT address + faucet URL) when NIGHT is zero.
 * On the local standalone chain, where genesis funds root by construction, a
 * zero balance is instead retried until the indexer catches up (see
 * {@link GENESIS_INDEX_TIMEOUT_MS}). Root pays the children's funding
 * transfers in DUST, so with NIGHT proven present it finishes through
 * {@link ensureFeeReady}: a faucet-funded root needs its NIGHT registered for
 * dust generation before it holds any spendable DUST.
 *
 * @param config - The stack the root wallet connects to.
 * @param rootSeed - The root wallet seed.
 * @param faucetUrl - The network's faucet URL for the underfunded message.
 * @returns The root's fee-ready funding snapshot.
 * @throws {RootUnfundedError} If root holds no NIGHT, or if no dust
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
    let night = totalNight(state);
    if (night === 0n && isLocalStandaloneNetwork(config.networkId)) {
      const deadline = Date.now() + GENESIS_INDEX_TIMEOUT_MS;
      while (night === 0n && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, GENESIS_INDEX_POLL_INTERVAL_MS));
        state = await facade.waitForSyncedState();
        night = totalNight(state);
      }
    }
    if (night === 0n) {
      throw new RootUnfundedError(addresses.unshielded, faucetUrl);
    }
    const dust = await ensureFeeReady(facade, keys, state, config.networkId, faucetUrl);
    return { addresses, night, dust };
  });
}

/**
 * Bring one child wallet to fee-ready by topping it up from root: if it holds
 * no NIGHT, transfer `amount` from root and wait for the child to see it, then
 * finish through {@link ensureFeeReady}. A child that already holds NIGHT but
 * no dust yet is only registered and waited on (no transfer). Call only for a
 * child that is not already fee-ready.
 *
 * @param config - The stack both wallets connect to.
 * @param rootSeed - The funding wallet's seed.
 * @param childSeed - The child wallet's seed.
 * @param amount - NIGHT to transfer when the child holds none, in base units.
 * @returns The child's post-funding snapshot.
 * @throws {Error} If root cannot cover the transfer, or dust never appears in time.
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

  const before = await withSyncedWalletFacade(childKeys, config, (_f, s) =>
    Promise.resolve(totalNight(s)),
  );

  if (before === 0n) {
    await withSyncedWalletFacade(rootKeys, config, async (rootFacade, rootState) => {
      await transferNight(
        rootFacade,
        rootKeys,
        rootState,
        childAddresses.unshielded,
        config.networkId,
        amount,
      );
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
      throw new Error(
        `child wallet ${childAddresses.unshielded} shows no NIGHT after funding from root`,
      );
    }
    const dust = await ensureFeeReady(childFacade, childKeys, state, config.networkId);
    return { addresses: childAddresses, night: totalNight(state), dust };
  });
}
