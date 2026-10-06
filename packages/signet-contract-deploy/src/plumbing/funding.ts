import { formatDust } from "./format-dust.ts";
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
  type WalletRegistry,
} from "./wallet.ts";

/** The registry's root wallet label, shared by every primitive that logs it. */
const ROOT_LABEL = "root";

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
 * Read a wallet's funding snapshot (addresses + NIGHT + DUST) from its synced
 * state, syncing it first if the registry has not opened it yet.
 *
 * @param wallets - The registry holding the wallet.
 * @param seed - The wallet seed (hex or mnemonic).
 * @param label - The wallet's role name, for the sync log.
 * @returns The synced {@link AccountFunding}.
 */
export async function readAccountFunding(
  wallets: WalletRegistry,
  seed: string,
  label: string,
): Promise<AccountFunding> {
  const { facade, keys } = await wallets.wallet(seed, label);
  const state = await facade.waitForSyncedState();
  return {
    addresses: deriveAddresses(keys, wallets.config.networkId),
    night: totalNight(state),
    dust: state.dust.balance(new Date()),
  };
}

/**
 * A wallet is fee-ready when its spendable DUST covers `minimumDust`.
 *
 * @param funding - The wallet's measured funding.
 * @param minimumDust - The spendable DUST that counts as ready, in base units, 1 (any dust at all) by default.
 * @returns Whether the wallet can pay fees right now.
 */
export function isFeeReady(funding: AccountFunding, minimumDust = 1n): boolean {
  return funding.dust >= minimumDust;
}

/**
 * A wallet holds no NIGHT and not enough DUST, so it cannot pay fees until
 * its NIGHT receive address is funded (on a deployed network, via the
 * network's faucet). Thrown by {@link ensureFeeReady} and {@link assertRootFunded},
 * carrying the exact address and faucet URL to act on, so a setup pipeline
 * can STOP printing them.
 */
export class WalletUnfundedError extends Error {
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
      `wallet holds no NIGHT and so cannot generate the DUST that pays fees. Fund it ${where}, then retry.\n` +
        `  NIGHT address: ${nightAddress}` +
        (faucetUrl ? `\n  faucet:        ${faucetUrl}` : ""),
    );
    this.name = "WalletUnfundedError";
  }
}

/**
 * Bring one wallet to fee-ready and return its spendable DUST balance. Fees
 * are paid in DUST, which only generates on NIGHT registered for dust
 * generation, so every unregistered NIGHT UTXO the wallet holds is registered
 * here first, whatever its current dust: a faucet top-up or transfer change
 * arrives unregistered, and leaving it so while older dust lasts would let
 * the wallet's dust generation shrink with every spend. Then a wallet holding
 * at least `minimumDust` of spendable dust returns it, and one without waits
 * until it does: a few blocks for a fresh registration, longer for a
 * multi-transaction budget. A flow about to submit several transactions
 * passes their total fee as `minimumDust`, so a wallet that cannot cover
 * them stops here with the shortfall named and nothing submitted. The facade
 * must be started and synced, and `state` must be its synced state (see
 * `withSyncedWalletFacade` in wallet.ts).
 *
 * @param facade - A started wallet facade for `keys`, which submits the registration.
 * @param keys - The key material of the same wallet. Its keystore signs the registration.
 * @param state - The synced facade state the balances and NIGHT UTXOs are read from.
 * @param networkId - The network the wallet lives on, which prefixes the
 *   NIGHT receive address the no-NIGHT error prints for faucet funding.
 * @param faucetUrl - The network's faucet for the no-NIGHT hint, when one is known.
 * @param minimumDust - The spendable DUST to require, in base units, 1 (any dust at all) by default.
 * @param timeoutMs - Spendable DUST wait deadline in milliseconds, after registration.
 * @returns The wallet's spendable DUST balance, at least `minimumDust`.
 * @throws {WalletUnfundedError} If the wallet holds no NIGHT and less than `minimumDust` of DUST.
 * @throws {Error} If the dust stays below `minimumDust` for the wait's timeout (see
 *   {@link waitForSpendableDust}).
 */
export async function ensureFeeReady(
  facade: WalletFacade,
  keys: AccountKeys,
  state: FacadeState,
  networkId: NetworkId,
  faucetUrl?: string,
  minimumDust = 1n,
  timeoutMs?: number,
): Promise<bigint> {
  const dust = state.dust.balance(new Date());
  if (totalNight(state) === 0n) {
    if (dust >= minimumDust) return dust;
    throw new WalletUnfundedError(deriveAddresses(keys, networkId).unshielded, faucetUrl);
  }
  const registered = await registerNightForDustGeneration(facade, keys, state);
  if (registered > 0) {
    console.log(`registered ${String(registered)} NIGHT UTXO(s) for dust generation`);
  }
  if (dust >= minimumDust) return dust;
  console.log(
    `waiting for spendable DUST (have ${formatDust(dust)}, need at least ${formatDust(minimumDust)})...`,
  );
  return waitForSpendableDust(facade, minimumDust, timeoutMs);
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
 * {@link WalletUnfundedError} (NIGHT address + faucet URL) when NIGHT is zero.
 * On the local standalone chain, where genesis funds root by construction, a
 * zero balance is instead retried until the indexer catches up (see
 * {@link GENESIS_INDEX_TIMEOUT_MS}). Root pays the children's funding
 * transfers in DUST, so with NIGHT proven present it finishes through
 * {@link ensureFeeReady}: a faucet-funded root needs its NIGHT registered for
 * dust generation before it holds any spendable DUST.
 *
 * @param wallets - The registry holding the root wallet.
 * @param rootSeed - The root wallet seed.
 * @param faucetUrl - The network's faucet URL for the underfunded message.
 * @returns The root's fee-ready funding snapshot.
 * @throws {WalletUnfundedError} If root holds no NIGHT.
 * @throws {Error} If no dust appears in time after registration (see
 *   {@link waitForSpendableDust}): root is funded but not yet fee-ready, so
 *   this is a plain error, not a funding stop.
 */
export async function assertRootFunded(
  wallets: WalletRegistry,
  rootSeed: string,
  faucetUrl: string | undefined,
): Promise<AccountFunding> {
  const { networkId } = wallets.config;
  const { facade, keys } = await wallets.wallet(rootSeed, ROOT_LABEL);
  const addresses = deriveAddresses(keys, networkId);
  let state = await facade.waitForSyncedState();
  let night = totalNight(state);
  if (night === 0n && isLocalStandaloneNetwork(networkId)) {
    const deadline = Date.now() + GENESIS_INDEX_TIMEOUT_MS;
    while (night === 0n && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, GENESIS_INDEX_POLL_INTERVAL_MS));
      state = await facade.waitForSyncedState();
      night = totalNight(state);
    }
  }
  if (night === 0n) {
    throw new WalletUnfundedError(addresses.unshielded, faucetUrl);
  }
  const dust = await ensureFeeReady(facade, keys, state, networkId, faucetUrl);
  return { addresses, night, dust };
}

/**
 * Bring one child wallet to fee-ready by topping it up from root: if it holds
 * no NIGHT, transfer `amount` from root and wait for the child to see it, then
 * finish through {@link ensureFeeReady}. A child that already holds NIGHT but
 * no dust yet is registered and waited on. A sufficient DUST balance returns immediately.
 *
 * @param wallets - The registry holding both wallets.
 * @param rootSeed - The funding wallet's seed.
 * @param childSeed - The child wallet's seed.
 * @param childLabel - The child's role name, for the sync log.
 * @param amount - NIGHT to transfer when the child holds none, in base units.
 * @param minimumDust - Required spendable DUST in SPECKs.
 * @returns The child's post-funding snapshot.
 * @throws {Error} If root cannot cover the transfer, or dust never appears in time.
 */
export async function fundChildFromRoot(
  wallets: WalletRegistry,
  rootSeed: string,
  childSeed: string,
  childLabel: string,
  amount: bigint,
  minimumDust = 1n,
): Promise<AccountFunding> {
  const { networkId } = wallets.config;
  const child = await wallets.wallet(childSeed, childLabel);
  const childAddresses = deriveAddresses(child.keys, networkId);
  let state = await child.facade.waitForSyncedState();
  const available: bigint = state.dust.balance(new Date());
  if (available >= minimumDust) {
    console.log(
      `${childLabel}: available ${formatDust(available)} DUST, required ${formatDust(minimumDust)} DUST, funding skipped`,
    );
    return { addresses: childAddresses, night: totalNight(state), dust: available };
  }

  if (totalNight(state) === 0n) {
    const root = await wallets.wallet(rootSeed, ROOT_LABEL);
    const rootState = await root.facade.waitForSyncedState();
    await transferNight(
      root.facade,
      root.keys,
      rootState,
      childAddresses.unshielded,
      networkId,
      amount,
    );
  }

  // Wait for the transferred NIGHT UTXO to land in the child's synced view.
  for (let i = 0; i < 40 && totalNight(state) === 0n; i++) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    state = await child.facade.waitForSyncedState();
  }
  if (totalNight(state) === 0n) {
    throw new Error(
      `child wallet ${childAddresses.unshielded} shows no NIGHT after funding from root`,
    );
  }
  const dust = await ensureFeeReady(
    child.facade,
    child.keys,
    state,
    networkId,
    undefined,
    minimumDust,
  );
  return { addresses: childAddresses, night: totalNight(state), dust };
}
