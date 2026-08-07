// Loopback tests of the remote-wallet protocol: a RemoteWallet client
// wired straight into a RemoteWalletServer over an in-process transport,
// with a canned Wallet behind it. Every assertion crosses the full wire
// path (encode, deliver, decode on the server, call the wallet, encode,
// decode on the client), so the shared codecs are exercised from both
// sides at once.

import {
  sampleSigningKey,
  signatureVerifyingKey,
  signData as ledgerSignData,
  Transaction,
  verifySignature,
} from "@midnightntwrk/ledger-v9";
import { describe, expect, it } from "vitest";

import {
  REMOTE_WALLET_PROTOCOL_VERSION,
  RemoteWallet,
  RemoteWalletMethod,
  RemoteWalletServer,
  type RemoteWalletTransport,
  type Wallet,
} from "../src/index.ts";

const SIGNING_KEY = sampleSigningKey();

const HOST_ADDRESSES = {
  unshielded: "mn_addr_undeployed1host",
  shielded: "mn_shield-addr_undeployed1host",
  dust: "mn_dust-addr_undeployed1host",
};
const HOST_COIN_PUBLIC_KEY = "c0".repeat(32);
const HOST_ENCRYPTION_PUBLIC_KEY = "e0".repeat(32);
const SHIELDED_BALANCES = { "shielded-token-a": 5n, "shielded-token-b": 0n };
const UNSHIELDED_BALANCES = { night: 123_456_789_012_345_678_901_234_567_890n };
const DUST_BALANCE = 42_000_000_000n;

// The canned wallet behind the server: fixed identity and balances, real
// ledger signing, mock proving for balancing, and the transaction's own
// hash as the submit id. `lastBalanceTtl` captures what the server-side
// decode handed the wallet, so the ttl wire fidelity is observable;
// `hostSynced` is mutable so the sync probe and barrier are testable in
// both states.
let lastBalanceTtl: Date | undefined;
let hostSynced = true;
const hostWallet: Wallet = {
  getAddresses: () => HOST_ADDRESSES,
  getNetworkId: () => "undeployed",
  synced: () => Promise.resolve(hostSynced),
  waitForSync: () => Promise.resolve(),
  getCoinPublicKey: () => HOST_COIN_PUBLIC_KEY,
  getEncryptionPublicKey: () => HOST_ENCRYPTION_PUBLIC_KEY,
  getShieldedBalances: () => Promise.resolve(SHIELDED_BALANCES),
  getUnshieldedBalances: () => Promise.resolve(UNSHIELDED_BALANCES),
  getDustBalance: () => Promise.resolve(DUST_BALANCE),
  signData: (data) => Promise.resolve(ledgerSignData(SIGNING_KEY, data)),
  balanceTx: () =>
    Promise.reject(new Error("balanceTx is not exercised: an UnboundTransaction needs a prover")),
  balanceUnprovenTx: (tx, ttl) => {
    lastBalanceTtl = ttl;
    return Promise.resolve(tx.mockProve());
  },
  submitTx: (tx) => Promise.resolve(tx.transactionHash()),
};

async function connectedRemoteWallet(): Promise<RemoteWallet> {
  const server = new RemoteWalletServer(hostWallet);
  const wallet = new RemoteWallet((method, request) => server.handle(method, request));
  await wallet.connect();
  return wallet;
}

describe("RemoteWallet over a loopback transport", () => {
  it("answers the synchronous identity reads from the handshake", async () => {
    const wallet = await connectedRemoteWallet();
    expect(wallet.getAddresses()).toEqual(HOST_ADDRESSES);
    expect(wallet.getNetworkId()).toBe("undeployed");
    expect(wallet.getCoinPublicKey()).toBe(HOST_COIN_PUBLIC_KEY);
    expect(wallet.getEncryptionPublicKey()).toBe(HOST_ENCRYPTION_PUBLIC_KEY);
  });

  it("probes the host's sync state over the wire", async () => {
    const wallet = await connectedRemoteWallet();
    hostSynced = true;
    await expect(wallet.synced()).resolves.toBe(true);
    hostSynced = false;
    await expect(wallet.synced()).resolves.toBe(false);
    hostSynced = true;
  });

  it("waitForSync returns once the host reports synced", async () => {
    const wallet = await connectedRemoteWallet();
    hostSynced = true;
    await expect(wallet.waitForSync(5_000)).resolves.toBeUndefined();
  });

  it("waitForSync polls until the host becomes synced", async () => {
    const wallet = await connectedRemoteWallet();
    hostSynced = false;
    setTimeout(() => {
      hostSynced = true;
    }, 1_200);
    await expect(wallet.waitForSync(10_000)).resolves.toBeUndefined();
  });

  it("waitForSync throws once the deadline passes unsynced", async () => {
    const wallet = await connectedRemoteWallet();
    hostSynced = false;
    await expect(wallet.waitForSync(0)).rejects.toThrow("not synced after 0 ms");
    hostSynced = true;
  });

  it("round-trips balances with bigint fidelity", async () => {
    const wallet = await connectedRemoteWallet();
    await expect(wallet.getShieldedBalances()).resolves.toEqual(SHIELDED_BALANCES);
    await expect(wallet.getUnshieldedBalances()).resolves.toEqual(UNSHIELDED_BALANCES);
    await expect(wallet.getDustBalance()).resolves.toBe(DUST_BALANCE);
  });

  it("round-trips a signature that verifies against the host key", async () => {
    const wallet = await connectedRemoteWallet();
    const data = new Uint8Array([1, 2, 3, 250]);
    const signature = await wallet.signData(data);
    expect(verifySignature(signatureVerifyingKey(SIGNING_KEY), data, signature)).toBe(true);
  });

  it("round-trips transactions and the ttl through balanceUnprovenTx", async () => {
    const wallet = await connectedRemoteWallet();
    const unproven = Transaction.fromParts("undeployed");
    const ttl = new Date("2026-08-07T12:00:00.000Z");
    const finalized = await wallet.balanceUnprovenTx(unproven, ttl);
    expect(finalized.transactionHash()).toBe(unproven.mockProve().transactionHash());
    expect(lastBalanceTtl).toEqual(ttl);
  });

  it("omits the ttl on the wire when the caller gives none", async () => {
    const wallet = await connectedRemoteWallet();
    await wallet.balanceUnprovenTx(Transaction.fromParts("undeployed"));
    expect(lastBalanceTtl).toBeUndefined();
  });

  it("submits a finalized transaction and returns the host's id", async () => {
    const wallet = await connectedRemoteWallet();
    const finalized = Transaction.fromParts("undeployed").mockProve();
    await expect(wallet.submitTx(finalized)).resolves.toBe(finalized.transactionHash());
  });

  it("throws loudly before connect()", async () => {
    const server = new RemoteWalletServer(hostWallet);
    const wallet = new RemoteWallet((method, request) => server.handle(method, request));
    expect(() => wallet.getAddresses()).toThrow("not connected");
    await expect(wallet.getDustBalance()).rejects.toThrow("not connected");
  });

  it("is dead after disconnect()", async () => {
    const wallet = await connectedRemoteWallet();
    wallet.disconnect();
    expect(() => wallet.getAddresses()).toThrow("disconnected");
    expect(() => wallet.connect()).toThrow("disconnected");
  });

  it("refuses a handshake naming an unknown network", async () => {
    const server = new RemoteWalletServer(hostWallet);
    const tamperedNetwork: RemoteWalletTransport = async (method, request) => {
      const response = await server.handle(method, request);
      if (method !== RemoteWalletMethod.Handshake) return response;
      const handshake = JSON.parse(new TextDecoder().decode(response)) as Record<string, unknown>;
      const tampered = { ...handshake, networkId: "mars" };
      return new TextEncoder().encode(JSON.stringify(tampered));
    };
    await expect(new RemoteWallet(tamperedNetwork).connect()).rejects.toThrow(
      'unknown network "mars"',
    );
  });

  it("refuses a host speaking a different protocol version", async () => {
    const server = new RemoteWalletServer(hostWallet);
    const tamperedVersion: RemoteWalletTransport = async (method, request) => {
      const response = await server.handle(method, request);
      if (method !== RemoteWalletMethod.Handshake) return response;
      const handshake = JSON.parse(new TextDecoder().decode(response)) as Record<string, unknown>;
      const tampered = { ...handshake, protocolVersion: REMOTE_WALLET_PROTOCOL_VERSION + 1 };
      return new TextEncoder().encode(JSON.stringify(tampered));
    };
    await expect(new RemoteWallet(tamperedVersion).connect()).rejects.toThrow(
      "protocol version mismatch",
    );
  });

  it("rejects an unknown method on the server", async () => {
    const server = new RemoteWalletServer(hostWallet);
    await expect(server.handle("stealFunds", new Uint8Array(0))).rejects.toThrow(
      'unknown method "stealFunds"',
    );
  });

  it("rejects a malformed payload on the server", async () => {
    const server = new RemoteWalletServer(hostWallet);
    await expect(
      server.handle(RemoteWalletMethod.SignData, new TextEncoder().encode("not json")),
    ).rejects.toThrow("not valid JSON");
  });
});
