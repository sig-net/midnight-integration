// Network identity — the single source of named network ids.
//
// midnight-js types a network id as a bare `string` (`NetworkId`) with no
// companion enum, so the named values live here. Convention: a network id is
// ALWAYS named `networkId` and ALWAYS typed `NetworkId`.
import type { NetworkId as MidnightSDKNetworkId } from "@midnight-ntwrk/midnight-js/network-id";

/** A Midnight network id: the SDK's bare-string type plus our known named networks. */
export type NetworkId =
    // Include the SDK type so we stay assignable if it ever narrows.
    MidnightSDKNetworkId |
    // Local standalone stack (Docker node + indexer + proof server on localhost).
    "undeployed" |
    // Public test network for early/breaking changes — bleeding-edge ledger.
    "preview" |
    // Public test network that mirrors mainnet config; the final staging step.
    "preprod" |
    // Production network (live, real value).
    "mainnet";

// All known network ids, for runtime validation and iteration.
export const NETWORK_IDS: readonly NetworkId[] = [
    "undeployed",
    "preview",
    "preprod",
    "mainnet",
];
