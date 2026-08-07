// HTTP transport tests against a REAL node:http host wrapping a
// RemoteWalletServer, driven by createHttpRemoteWalletTransport through
// global fetch. The host here is also the reference server binding the
// README shows, so the documented snippet stays executed.

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { buffer } from "node:stream/consumers";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createHttpRemoteWalletTransport,
  RemoteWallet,
  RemoteWalletServer,
  type Wallet,
} from "../src/index.ts";

const HOST_ADDRESSES = {
  unshielded: "mn_addr_undeployed1httphost",
  shielded: "mn_shield-addr_undeployed1httphost",
  dust: "mn_dust-addr_undeployed1httphost",
};
const DUST_BALANCE = 7_000n;

// Minimal canned wallet: the transport tests exercise the handshake, one
// read, and the error path; every other method loudly reports it is out
// of scope, which doubles as the host-side failure these tests observe
// as an HTTP 500.
const notExercised = <Value>(): Promise<Value> =>
  Promise.reject(new Error("not exercised by the transport tests"));
const hostWallet: Wallet = {
  getAddresses: () => HOST_ADDRESSES,
  getNetworkId: () => "undeployed",
  synced: notExercised,
  waitForSync: notExercised,
  getCoinPublicKey: () => "c1".repeat(32),
  getEncryptionPublicKey: () => "e1".repeat(32),
  getShieldedBalances: notExercised,
  getUnshieldedBalances: notExercised,
  getDustBalance: () => Promise.resolve(DUST_BALANCE),
  signData: notExercised,
  balanceTx: notExercised,
  balanceUnprovenTx: notExercised,
  submitTx: notExercised,
};

let httpServer: Server;
let baseUrl: URL;
const seenPaths: string[] = [];
const seenHeaders: IncomingHttpHeaders[] = [];

beforeAll(async () => {
  const walletServer = new RemoteWalletServer(hostWallet);
  httpServer = createServer((request, response) => {
    void (async () => {
      seenPaths.push(request.url ?? "");
      seenHeaders.push(request.headers);
      try {
        const method = request.url?.split("/").at(-1) ?? "";
        const body = await walletServer.handle(method, new Uint8Array(await buffer(request)));
        response.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
      } catch (error) {
        response
          .writeHead(500, { "content-type": "text/plain" })
          .end(error instanceof Error ? error.message : "request failed");
      }
    })();
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("http server has no bound port");
  }
  // No trailing slash on purpose: the transport must add it.
  baseUrl = new URL(`http://127.0.0.1:${String(address.port)}/wallet/v1`);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

describe("createHttpRemoteWalletTransport", () => {
  it("drives a RemoteWallet end to end over real HTTP", async () => {
    const wallet = new RemoteWallet(createHttpRemoteWalletTransport(baseUrl));
    await wallet.connect();
    expect(wallet.getAddresses()).toEqual(HOST_ADDRESSES);
    await expect(wallet.getDustBalance()).resolves.toBe(DUST_BALANCE);
  });

  it("POSTs each method to baseUrl/<method>", async () => {
    seenPaths.length = 0;
    const wallet = new RemoteWallet(createHttpRemoteWalletTransport(baseUrl));
    await wallet.connect();
    await wallet.getDustBalance();
    expect(seenPaths).toEqual(["/wallet/v1/handshake", "/wallet/v1/getDustBalance"]);
  });

  it("sends the custom headers with every request", async () => {
    seenHeaders.length = 0;
    const wallet = new RemoteWallet(
      createHttpRemoteWalletTransport(baseUrl, {
        headers: { authorization: "Bearer test-token" },
      }),
    );
    await wallet.connect();
    await wallet.getDustBalance();
    expect(seenHeaders).toHaveLength(2);
    for (const headers of seenHeaders) {
      expect(headers.authorization).toBe("Bearer test-token");
      expect(headers["content-type"]).toBe("application/octet-stream");
    }
  });

  it("surfaces a non-2xx response as an error with status and body", async () => {
    const wallet = new RemoteWallet(createHttpRemoteWalletTransport(baseUrl));
    await wallet.connect();
    await expect(wallet.getShieldedBalances()).rejects.toThrow(
      "remote wallet host answered getShieldedBalances with HTTP 500: " +
        "not exercised by the transport tests",
    );
  });
});
