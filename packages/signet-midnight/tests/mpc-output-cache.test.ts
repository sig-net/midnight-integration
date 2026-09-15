// MpcOutputCacheReader against an in-process HTTP server standing in for the
// bucket. No network beyond loopback, no compiled contract.

import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  MidnightNetwork,
  MPC_FAILURE_OUTPUT,
  MpcOutputCacheReader,
  parseRequestIdHex,
} from "../src/index.ts";

const REQUEST_ID = parseRequestIdHex("5c".repeat(32));
const NETWORK_ID = "stagenet";
const SIGNET_CONTRACT_ADDRESS = "ab".repeat(32);
const EXPECTED_OBJECT_PATH = `/v1/stagenet/${NETWORK_ID}/${SIGNET_CONTRACT_ADDRESS}/${REQUEST_ID}.bin`;

let server: Server | undefined;

afterEach(
  () =>
    new Promise<void>((resolve) => {
      if (server === undefined) {
        resolve();
        return;
      }
      server.close(() => {
        resolve();
      });
      server = undefined;
    }),
);

/** What the bucket stand-in answers every request with. */
interface BucketReply {
  readonly status: number;
  readonly body: Uint8Array;
}

/** Start a server answering every request with `reply`, recording each request path into `paths`. */
async function serveBucket(reply: BucketReply, paths: string[]): Promise<string> {
  const started = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.writeHead(reply.status, { "content-type": "application/octet-stream" });
    response.end(Buffer.from(reply.body));
  });
  server = started;
  await new Promise<void>((resolve) => started.listen(0, "127.0.0.1", resolve));
  const address = started.address();
  if (address === null || typeof address === "string") {
    throw new Error("the bucket server has no TCP address");
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

describe("MpcOutputCacheReader", () => {
  it.each([
    { name: "a bare cache URL", suffix: "" },
    { name: "a cache URL with a trailing slash", suffix: "/" },
  ])(
    "locates the object under <prefix>/<network>/<signet>/<request>.bin from $name",
    ({ suffix }) => {
      const reader = new MpcOutputCacheReader({
        cacheUrl: `https://storage.googleapis.com/midnight-cache-storage-dev/v1/stagenet${suffix}`,
        networkId: NETWORK_ID,
        signetContractAddress: SIGNET_CONTRACT_ADDRESS,
      });
      expect(reader.objectUrl(REQUEST_ID)).toBe(
        `https://storage.googleapis.com/midnight-cache-storage-dev${EXPECTED_OBJECT_PATH}`,
      );
    },
  );

  it("defaults to the cache the package publishes for the network", () => {
    const reader = new MpcOutputCacheReader({
      networkId: MidnightNetwork.Stagenet,
      signetContractAddress: SIGNET_CONTRACT_ADDRESS,
    });
    expect(reader.objectUrl(REQUEST_ID)).toBe(
      `https://storage.googleapis.com/midnight-cache-storage-dev${EXPECTED_OBJECT_PATH}`,
    );
  });

  it.each([
    {
      networkId: MidnightNetwork.Undeployed,
      expected: /no MPC output cache is published for the 'undeployed' network: pass cacheUrl/,
    },
    {
      networkId: MidnightNetwork.Preview,
      expected: /no MPC output cache URL published for the 'preview' network yet/,
    },
  ])("refuses to default on $networkId", ({ networkId, expected }) => {
    expect(
      () => new MpcOutputCacheReader({ networkId, signetContractAddress: SIGNET_CONTRACT_ADDRESS }),
    ).toThrow(expected);
  });

  it.each([
    {
      name: "a one-byte packed transfer result",
      reply: { status: 200, body: new Uint8Array([0x01]) },
      expected: new Uint8Array([0x01]),
    },
    {
      name: "the failure output verbatim",
      reply: { status: 200, body: MPC_FAILURE_OUTPUT },
      expected: MPC_FAILURE_OUTPUT,
    },
    {
      name: "an empty object",
      reply: { status: 200, body: new Uint8Array() },
      expected: new Uint8Array(),
    },
    {
      name: "no object yet",
      reply: {
        status: 404,
        body: new TextEncoder().encode("<Error><Code>NoSuchKey</Code></Error>"),
      },
      expected: undefined,
    },
  ])("returns $name", async ({ reply, expected }) => {
    const paths: string[] = [];
    const baseUrl = await serveBucket(reply, paths);
    const reader = new MpcOutputCacheReader({
      cacheUrl: `${baseUrl}/v1/stagenet`,
      networkId: NETWORK_ID,
      signetContractAddress: SIGNET_CONTRACT_ADDRESS,
    });
    const fetched = await reader.fetchSerializedOutput(REQUEST_ID);
    expect(fetched).toEqual(expected);
    expect(paths).toEqual([EXPECTED_OBJECT_PATH]);
  });

  it.each([
    { status: 403, body: "AccessDenied" },
    { status: 500, body: "InternalError" },
  ])("throws on HTTP $status, quoting the object URL and body", async ({ status, body }) => {
    const paths: string[] = [];
    const baseUrl = await serveBucket({ status, body: new TextEncoder().encode(body) }, paths);
    const reader = new MpcOutputCacheReader({
      cacheUrl: `${baseUrl}/v1/stagenet`,
      networkId: NETWORK_ID,
      signetContractAddress: SIGNET_CONTRACT_ADDRESS,
    });
    await expect(reader.fetchSerializedOutput(REQUEST_ID)).rejects.toThrow(
      `MPC output cache answered HTTP ${String(status)} for ${baseUrl}${EXPECTED_OBJECT_PATH}: ${body}`,
    );
  });

  it("throws when the cache is unreachable", async () => {
    const reader = new MpcOutputCacheReader({
      cacheUrl: "http://127.0.0.1:1/v1/stagenet",
      networkId: NETWORK_ID,
      signetContractAddress: SIGNET_CONTRACT_ADDRESS,
    });
    await expect(reader.fetchSerializedOutput(REQUEST_ID)).rejects.toThrow();
  });
});
