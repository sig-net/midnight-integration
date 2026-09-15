// Reader over the MPC's output cache: the exact serialised output bytes the
// MPC attests for a bidirectional request, stored as one object per request
// id in a public bucket BEFORE the attestation is posted on chain. A Compact
// circuit fixes its byte-payload width at compile time while serialised
// outputs vary in size across requests, so the signet contract carries the
// signature alone and the cache carries the bytes. An object holds nothing
// but the packed output, and is UNTRUSTED until the attestation signature
// verifies over it (`verifyRespondBidirectionalSignature`).

import type { RequestIdHex } from "./signet-requests.ts";

/** Where the MPC's output cache lives and which of its namespaces to read. */
export interface MpcOutputCacheConfig {
  /**
   * The cache's public URL down to the MPC's configured object prefix, e.g.
   * `https://storage.googleapis.com/<bucket>/<prefix>`. A trailing slash is
   * tolerated.
   */
  readonly cacheUrl: string;
  /** The Midnight network id the MPC serves: the path segment after the prefix. */
  readonly networkId: string;
  /** The signet singleton the MPC publishes through, 64 hex chars: the segment after the network. */
  readonly signetContractAddress: string;
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
   */
  constructor(config: MpcOutputCacheConfig) {
    const prefixUrl = config.cacheUrl.replace(/\/+$/u, "");
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
