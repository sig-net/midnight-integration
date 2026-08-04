// Network identity plumbing. The named networks live in @sig-net/midnight's
// MidnightNetwork enum (the protocol library sits at the root of the
// dependency graph, so every @sig-net/midnight* package can reach it); this
// module widens the enum back to the SDK's bare-string network-id type and
// adds the deploy-side helpers. Convention: a network id is ALWAYS named
// `networkId` and ALWAYS typed `NetworkId`.
import type { NetworkId as MidnightSDKNetworkId } from "@midnight-ntwrk/midnight-js/network-id";
import { MidnightNetwork } from "@sig-net/midnight";

export { MidnightNetwork };

/** A Midnight network id: the SDK's bare-string type plus the named networks. */
export type NetworkId = MidnightSDKNetworkId | MidnightNetwork;

// All known network ids, for runtime validation and iteration.
export const NETWORK_IDS: readonly NetworkId[] = Object.values(MidnightNetwork);

/**
 * Whether a network's genesis mint wallet is pre-funded. TRUE only for the
 * local standalone chain ({@link MidnightNetwork.Undeployed}), whose genesis
 * block mints to the well-known genesis seed. Every deployed network
 * (preview / preprod / stagenet / mainnet) starts each wallet at zero, so a
 * run against one needs a seed funded out of band (via that network's
 * faucet).
 *
 * @param networkId - The network to classify.
 * @returns Whether the genesis mint wallet holds spendable funds here.
 */
export function isLocalStandaloneNetwork(networkId: NetworkId): boolean {
    return networkId === MidnightNetwork.Undeployed;
}
