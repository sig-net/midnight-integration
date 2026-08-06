// MPC routing constants, the padded-ASCII codec for the signet request
// structs, and the published per-network counterparty values (the MPC root
// public key and the signet contract address). Field widths mirror
// Signet.compact (the wire format: keep in lockstep), and the string
// constants are the values the MPC network routes on.
//
// The routing constants belong in github.com/sig-net/signet.js, kept here
// until upstreamed.

/** Width of `SignBidirectionalEvent.caip2Id` (`Bytes<32>`). */
export const CAIP2_ID_BYTES = 32;

/** Width of `SignBidirectionalEvent.params` (`Bytes<64>`). */
export const MPC_PARAMS_BYTES = 64;

/** Width of `EvmCalldata.selector` (`Bytes<4>`): the literal first 4 calldata bytes. */
export const SELECTOR_BYTES = 4;

/**
 * The complete serialised output the MPC attests for a FAILED remote
 * execution (reverted or replaced transaction): the 4-byte error marker
 * `0xdeadbeef` followed by one `0x01` byte, mirroring the canonical MPC's
 * failure payload (sig-net/mpc, node/src/respond_bidirectional.rs). A
 * respond schema whose packed width is exactly 5 bytes could produce a
 * legitimate output equal to this sentinel: such clients must route
 * settlement by digest-candidate matching, never by inspecting output
 * bytes. See {@link isMpcFailureOutput}.
 */
export const MPC_FAILURE_OUTPUT = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01]);

/**
 * Whether an attested serialised output IS the MPC's fixed failure payload:
 * exact byte equality with the 5-byte {@link MPC_FAILURE_OUTPUT}.
 *
 * @param serializedOutput - The attested serialised output.
 * @returns `true` when the output equals the MPC failure payload exactly.
 */
export function isMpcFailureOutput(serializedOutput: Uint8Array): boolean {
  return (
    serializedOutput.length === MPC_FAILURE_OUTPUT.length &&
    MPC_FAILURE_OUTPUT.every((byte, index) => serializedOutput[index] === byte)
  );
}

/**
 * Default MPC key version (`keyVersion` field value). The canonical MPC
 * (and `constructSignBidirectionalEvent`) requires `keyVersion >= 1`.
 */
export const SIGNET_DEFAULT_KEY_VERSION = 1n;

/**
 * Encode text as zero-padded ASCII bytes, the Compact `pad(N, "text")`
 * convention every string-ish field of the request structs uses (consumers
 * NUL-trim on decode).
 *
 * @param text - The ASCII text to encode.
 * @param length - The fixed field width in bytes.
 * @returns `text`'s bytes followed by zero padding to exactly `length`.
 * @throws If the encoded text does not fit in `length` bytes.
 */
export function asciiPadded(text: string, length: number): Uint8Array {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length > length) {
    throw new Error(`"${text}" is ${encoded.length} bytes: does not fit the ${length}-byte field`);
  }
  const out = new Uint8Array(length);
  out.set(encoded);
  return out;
}

/**
 * A named Midnight network: the single source of the network names shared
 * across the `@sig-net/midnight*` packages.
 */
export enum MidnightNetwork {
  /** Local standalone stack (Docker node, indexer and proof server on localhost). */
  Undeployed = "undeployed",
  /** Public staging network, pre-preview. */
  Stagenet = "stagenet",
  /** Public test network for early and breaking changes (bleeding-edge ledger). */
  Preview = "preview",
  /** Public test network that mirrors mainnet config: the final staging step. */
  Preprod = "preprod",
  /** Production network (live, real value). */
  Mainnet = "mainnet",
}

/**
 * A public, long-lived Midnight network: every named network except the
 * local standalone stack. Only these have fixed protocol counterparty
 * values published in this package (see {@link getMpcRootPublicKey} and
 * {@link getSignetContractAddress}).
 */
export type DeployedNetwork = Exclude<MidnightNetwork, MidnightNetwork.Undeployed>;

// TODO: fill in each network's MPC root public key once it is generated and
// published for that network. An empty string means "not yet published" and
// makes getMpcRootPublicKey throw for that network.
const mpcRootPublicKeys: Record<DeployedNetwork, string> = {
  [MidnightNetwork.Stagenet]: "",
  [MidnightNetwork.Preview]: "",
  [MidnightNetwork.Preprod]: "",
  [MidnightNetwork.Mainnet]: "",
};

/**
 * The MPC root public key of a deployed Midnight network, as hex: the
 * `mpcRootPublicKey` every client key derivation starts from (see
 * `deriveEvmAddress`). A local standalone stack has no fixed key: its setup
 * generates a fresh `MPC_ROOT_KEY` per stack.
 *
 * @param networkId - The deployed network to look up.
 * @returns The network's MPC root public key.
 * @throws Error when the network's key is not yet published in this package.
 */
export function getMpcRootPublicKey(networkId: DeployedNetwork): string {
  const publicKey = mpcRootPublicKeys[networkId];
  if (!publicKey) {
    throw new Error(`no MPC root public key published for the '${networkId}' network yet`);
  }
  return publicKey;
}

// TODO: fill in each network's signet contract address as the signet
// singleton is deployed there. An empty string means "not yet deployed or
// published" and makes getSignetContractAddress throw for that network.
const signetContractAddresses: Record<DeployedNetwork, string> = {
  [MidnightNetwork.Stagenet]: "",
  [MidnightNetwork.Preview]: "",
  [MidnightNetwork.Preprod]: "",
  [MidnightNetwork.Mainnet]: "",
};

/**
 * The address of the central signet singleton contract on a deployed
 * Midnight network: the `signetContractAddress` a
 * `SignetRequestResponseReader` polls. A local standalone stack has no
 * fixed address: each stack deploys its own singleton.
 *
 * @param networkId - The deployed network to look up.
 * @returns The network's signet contract address.
 * @throws Error when the singleton's address is not yet published in this
 *   package.
 */
export function getSignetContractAddress(networkId: DeployedNetwork): string {
  const contractAddress = signetContractAddresses[networkId];
  if (!contractAddress) {
    throw new Error(`no signet contract address published for the '${networkId}' network yet`);
  }
  return contractAddress;
}