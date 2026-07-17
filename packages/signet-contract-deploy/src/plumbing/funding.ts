// Account funding preflight: the generic "can this wallet pay Midnight
// fees?" check shared by every account a run drives. Fees are paid in DUST,
// which only generates on NIGHT registered for dust generation, so an account
// is fee-ready only once it holds enough NIGHT AND that NIGHT is registered
// and has generated spendable dust. This is the one place that sequence lives.
//
// Deliberately generic over WHICH account: it takes a resolved seed + minimum
// and a faucet hint, so the deployer today and any funded sub-account a future
// suite adds pass the identical preflight. Creating and funding a fresh
// sub-account from a master wallet (the "not given → generate + fund + persist"
// branch) is intentionally NOT here yet: it lands with the first suite that
// needs a second account, wired through this same primitive.

import type { MidnightNodeConfig } from "./midnight-node-config.ts";
import {
  deriveAccountKeys,
  deriveAddresses,
  registerNightForDustGeneration,
  waitForSpendableDust,
  withSyncedWalletFacade,
  type FacadeState,
} from "./wallet.ts";

/** One account to fee-ready: its seed, the NIGHT floor it must clear, and where to top it up. */
export interface FundedAccountSpec {
  /** Human-readable role for log/error messages (e.g. `"deployer"`). */
  readonly label: string;
  /** The account's seed (hex or mnemonic). */
  readonly seed: string;
  /** Minimum NIGHT (base units) the account must hold; `0n` means "any positive balance". */
  readonly minNight: bigint;
  /** Faucet URL for the underfunded hint; omitted when the network publishes none. */
  readonly faucetUrl?: string;
}

/** Sum a wallet's unshielded NIGHT across its UTXOs, in base units. */
function totalNight(state: FacadeState): bigint {
  return Object.values(state.unshielded.balances).reduce((sum, value) => sum + value, 0n);
}

/**
 * Assert an account can pay transaction fees, and make it so: sync its wallet,
 * require it holds at least `spec.minNight` NIGHT (a positive balance when
 * `minNight` is `0n`) or throw with a faucet hint, register any unregistered
 * NIGHT for dust generation, then confirm (or wait for) a spendable DUST
 * balance. The local genesis wallet passes this too: its NIGHT is minted at
 * genesis and dust generates block by block, so the wait covers a young chain.
 *
 * @param config - The stack the account's wallet connects to.
 * @param spec - The account to make fee-ready; see {@link FundedAccountSpec}.
 * @throws If the wallet holds less than the required NIGHT (with a faucet
 *   hint and the receive address), or no spendable dust appears in time.
 */
export async function ensureFundedAccount(config: MidnightNodeConfig, spec: FundedAccountSpec): Promise<void> {
  const keys = deriveAccountKeys(spec.seed, config.networkId);
  const { unshielded: receiveAddress } = deriveAddresses(keys, config.networkId);

  await withSyncedWalletFacade(keys, config, async (facade, state) => {
    const night = totalNight(state);
    const required = spec.minNight > 0n ? spec.minNight : 1n;
    if (night < required) {
      const hint = spec.faucetUrl
        ? `request NIGHT for ${receiveAddress} at ${spec.faucetUrl}`
        : `fund ${receiveAddress} via the network's faucet`;
      throw new Error(
        `${spec.label} wallet holds ${night} NIGHT but needs at least ${required}: ${hint}, then retry.`,
      );
    }

    const registered = await registerNightForDustGeneration(facade, keys, state);
    if (registered > 0) {
      console.log(`registered ${registered} ${spec.label} NIGHT UTXO(s) for dust generation`);
    }

    // A balance visible now settles it; otherwise dust may still be generating
    // from a (possibly just-submitted) registration; wait for it.
    const dustNow = state.dust.balance(new Date());
    if (dustNow > 0n) {
      console.log(`${spec.label} dust (fee) balance: ${dustNow}`);
      return;
    }
    const dust = await waitForSpendableDust(facade);
    console.log(`${spec.label} dust (fee) balance: ${dust}`);
  });
}
