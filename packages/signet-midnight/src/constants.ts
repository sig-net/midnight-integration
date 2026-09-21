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
 * convention every string-ish field of the request structs uses.
 * {@link asciiUnpadded} is the inverse.
 *
 * @param text - The ASCII text to encode.
 * @param length - The fixed field width in bytes.
 * @returns `text`'s bytes followed by zero padding to exactly `length`.
 * @throws {Error} If the encoded text does not fit in `length` bytes.
 */
export function asciiPadded(text: string, length: number): Uint8Array {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length > length) {
    throw new Error(
      `"${text}" is ${String(encoded.length)} bytes: does not fit the ${String(length)}-byte field`,
    );
  }
  const out = new Uint8Array(length);
  out.set(encoded);
  return out;
}

/**
 * Decode a zero-padded text field: the inverse of {@link asciiPadded} and of
 * the Compact `pad(N, "text")` convention. Only the TRAILING zero bytes are
 * padding: a zero byte inside the text is kept.
 *
 * @param bytes - The padded field bytes.
 * @returns The text without its padding.
 */
export function asciiUnpadded(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) {
    end -= 1;
  }
  return new TextDecoder().decode(bytes.subarray(0, end));
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

// Each network's MPC root public key in the canonical `0x04…` uncompressed
// SEC1 hex (`normaliseSecp256k1PublicKey`), filled in as the MPC operators
// publish it for that network. An empty string means "not yet published" and
// makes getMpcRootPublicKey throw for that network.
const mpcRootPublicKeys: Record<DeployedNetwork, string> = {
  [MidnightNetwork.Stagenet]:
    // Canonical form of the signet.js TESTNET root key:
    // secp256k1:3Ww8iFjqTHufye5aRGUvrQqETegR4gVUcW8FX5xzscaN9ENhpkffojsxJwi6N1RbbHMTxYa9UyKeqK3fsMuwxjR5
    "0x047dd8ecafa5d9c921485b6ac33476870e98c3378e395f3c8fae92ce4943d8432847f591ab25ca454effb522ec2eaf04b7e1c83ba65ae731ea98dd52eb7d458dd4",
  [MidnightNetwork.Preview]: "",
  [MidnightNetwork.Preprod]: "",
  [MidnightNetwork.Mainnet]: "",
};

/**
 * The MPC root public key of a deployed Midnight network, as `0x04…`
 * uncompressed SEC1 hex (the canonical spelling of
 * `normaliseSecp256k1PublicKey`): the `mpcRootPublicKey` every client key
 * derivation starts from (see `deriveEvmAddress`). A local standalone stack
 * has no fixed key: its setup generates a fresh `MPC_ROOT_KEY` per stack.
 *
 * @param networkId - The deployed network to look up.
 * @returns The network's MPC root public key.
 * @throws {Error} When the network's key is not yet published in this package.
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
  [MidnightNetwork.Stagenet]: "1df4ce25fc9f9c03dc6f4d0eb12ddf3d0db094995d4c70aca1142eebb3b77a5d",
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
 * @throws {Error} When the singleton's address is not yet published in this
 *   package.
 */
export function getSignetContractAddress(networkId: DeployedNetwork): string {
  const contractAddress = signetContractAddresses[networkId];
  if (!contractAddress) {
    throw new Error(`no signet contract address published for the '${networkId}' network yet`);
  }
  return contractAddress;
}

// The public URL of each network's MPC output cache down to the MPC's
// configured object prefix (`publisher.output_storage.prefix`). An empty
// string means "no cache published" and makes getMpcOutputCacheUrl throw for
// that network.
const mpcOutputCacheUrls: Record<DeployedNetwork, string> = {
  [MidnightNetwork.Stagenet]:
    "https://storage.googleapis.com/midnight-cache-storage-dev/v1/stagenet",
  [MidnightNetwork.Preview]: "",
  [MidnightNetwork.Preprod]: "",
  [MidnightNetwork.Mainnet]: "",
};

/**
 * The public URL of the MPC's output cache on a deployed Midnight network,
 * down to the MPC's object prefix: the `cacheUrl` an `MpcOutputCacheReader`
 * defaults to. A local standalone stack has no published cache: its
 * responder serves its own.
 *
 * @param networkId - The deployed network to look up.
 * @returns The network's output cache URL.
 * @throws {Error} When no cache is published for the network in this
 *   package.
 */
export function getMpcOutputCacheUrl(networkId: DeployedNetwork): string {
  const cacheUrl = mpcOutputCacheUrls[networkId];
  if (!cacheUrl) {
    throw new Error(`no MPC output cache URL published for the '${networkId}' network yet`);
  }
  return cacheUrl;
}
