// Reader over the MPC's output cache: the exact serialised output bytes the
// MPC attests for a bidirectional request, stored as one object per request
// id in a public bucket BEFORE the attestation is posted on chain. A Compact
// circuit fixes its byte-payload width at compile time while serialised
// outputs vary in size across requests, so the attestation event carries the
// output's digest and width and the cache carries the bytes. An object holds nothing
// but the packed output, and is UNTRUSTED until the attestation signature
// verifies over it (`verifyRespondBidirectionalSignature`).

import { type DeployedNetwork, getMpcOutputCacheUrl, MidnightNetwork } from "./constants.ts";
import type { RequestIdHex } from "./signet-requests.ts";

/** Where the MPC's output cache lives and which of its namespaces to read. */
export interface MpcOutputCacheConfig {
  /**
   * The cache's public URL down to the MPC's configured object prefix, e.g.
   * `https://storage.googleapis.com/<bucket>/<prefix>`. A trailing slash is
   * tolerated. Defaults to the cache this package publishes for `networkId`
   * ({@link getMpcOutputCacheUrl}), so a network with none (the local
   * standalone stack) must pass it.
   */
  readonly cacheUrl?: string;
  /** The Midnight network id the MPC serves: the path segment after the prefix. */
  readonly networkId: string;
  /** The signet singleton the MPC publishes through, 64 hex chars: the segment after the network. */
  readonly signetContractAddress: string;
}

/** The networks this package may publish an output cache for: every named one but the local stack. */
const DEPLOYED_NETWORKS: readonly string[] = Object.values(MidnightNetwork).filter(
  (network) => network !== MidnightNetwork.Undeployed,
);

/**
 * The cache URL this package publishes for `networkId`.
 *
 * @param networkId - The Midnight network id the MPC serves.
 * @returns The published cache URL.
 * @throws {Error} When `networkId` is not a deployed network, or is one with
 *   no cache published yet.
 */
function publishedCacheUrl(networkId: string): string {
  if (!DEPLOYED_NETWORKS.includes(networkId)) {
    throw new Error(
      `no MPC output cache is published for the '${networkId}' network: pass cacheUrl`,
    );
  }
  return getMpcOutputCacheUrl(networkId as DeployedNetwork);
}

/**
 * Reads attested serialised outputs out of the MPC's output cache. The MPC
 * writes a request's bytes to
 * `<prefix>/<networkId>/<signetContractAddress>/<requestId>.bin` before it
 * posts the matching attestation, so once an attestation is on chain a
 * missing object is the MPC's cache write being lost, and an object found
 * before any attestation is still unverified.
 */
export class MpcOutputCacheReader {
  private readonly namespaceUrl: string;

  /**
   * @param config - The cache location and the namespace to read.
   * @throws {Error} When `cacheUrl` is omitted for a network this package
   *   publishes no cache for.
   */
  constructor(config: MpcOutputCacheConfig) {
    let prefixUrl = config.cacheUrl ?? publishedCacheUrl(config.networkId);
    while (prefixUrl.endsWith("/")) {
      prefixUrl = prefixUrl.slice(0, -1);
    }
    this.namespaceUrl = `${prefixUrl}/${config.networkId}/${config.signetContractAddress}`;
  }

  /**
   * The URL of the object holding `requestId`'s attested output.
   *
   * @param requestId - The request whose output object to locate.
   * @returns The object's public URL.
   */
  objectUrl(requestId: RequestIdHex): string {
    return `${this.namespaceUrl}/${requestId}.bin`;
  }

  /**
   * Download the serialised output the MPC cached for `requestId`, verbatim.
   * UNTRUSTED: verify the attestation signature over the returned bytes.
   *
   * @param requestId - The request whose attested output to fetch.
   * @returns The cached bytes, or `undefined` when the cache holds no object
   *   for the request (the MPC has not written it yet).
   * @throws {Error} If the cache cannot be reached or answers with a status
   *   other than 200 or 404.
   */
  async fetchSerializedOutput(requestId: RequestIdHex): Promise<Uint8Array | undefined> {
    const url = this.objectUrl(requestId);
    const response = await fetch(url);
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(
        `MPC output cache answered HTTP ${String(response.status)} for ${url}: ${await response.text()}`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
