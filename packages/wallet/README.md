# @sig-net/midnight-wallet

A wallet for the [Midnight blockchain](https://midnight.network), as used by the [Sig Network](https://sig.network) `@sig-net/midnight*` packages:

- **The `Wallet` interface**: midnight-js's `WalletProvider` + `MidnightProvider` roles (so one instance plugs into a `MidnightProviders` set as its `walletProvider` and `midnightProvider`), plus identity reads (addresses, public keys, network id), balance and sync-state reads (`synced`, `waitForSync`), raw data signing, and `balanceUnprovenTx` (the unproven-transaction counterpart of `balanceTx` a contract deploy needs). A `Wallet` received across an API boundary is ready to use: lifecycle lives on the implementations, so a borrower can never end a session it does not own. Chain reads barrier on sync internally, so they return a fresh view, possibly after a wait: `synced()` and `waitForSync(timeoutMs)` expose that barrier for pacing and health checks, and `getNetworkId()` lets a client verify it is on the same chain as the wallet before transacting.
- **`LocalWallet`**: the in-process implementation over the Midnight wallet-sdk facade. A seed goes in, a wallet comes out — key derivation and the facade stay internal. Construction is synchronous and offline (identity reads work unconnected); `connect()` / `disconnect()` bracket everything that touches the chain, and `withLocalWallet` wraps that lifecycle for scoped work. It also carries the funding operations only an in-process wallet can perform (NIGHT transfer, dust registration).
- **`RemoteWallet`**: the same interface fulfilled by a wallet hosted elsewhere. The package carries all the pieces of the remote protocol: `RemoteWallet` (the `Wallet`-shaped client, with `connect`/`disconnect` lifecycle on the class), the transport-agnostic stubs (`RemoteWalletClient`, `RemoteWalletServer`), the wire codecs both stubs share, and a fetch-based HTTP transport (`createHttpRemoteWalletTransport`). Sync stays entirely on the host: the client holds only the identity from the handshake. A host implements the server side by wrapping any ready `Wallet` (typically a connected `LocalWallet`) in `RemoteWalletServer` and binding its `handle` method to whatever transport it prefers.
- **Seed plumbing**: BIP-39/hex seed parsing and generation.
- **Network config**: the named networks, per-network default endpoints, and `getMidnightNodeConfig` to resolve endpoints from the environment.

## Install

```sh
npm install @sig-net/midnight-wallet
```

## Usage

```ts
import { getMidnightNodeConfig, LocalWallet, withLocalWallet } from "@sig-net/midnight-wallet";

const config = getMidnightNodeConfig(process.env);

// Offline: an unconnected wallet still knows its addresses.
console.log(new LocalWallet(process.env.WALLET_SEED ?? "", config).getAddresses().unshielded);

// Connected, scoped: construct, connect, run, disconnect.
const dust = await withLocalWallet(process.env.WALLET_SEED ?? "", config, (wallet) =>
  wallet.getDustBalance(),
);
```

Hosting a wallet remotely: the host wraps a ready `Wallet` in `RemoteWalletServer` and binds its `handle` method to a transport of its choosing, and the consumer hands `RemoteWallet` a function that delivers each `(method, bytes)` request to that host:

```ts
import { RemoteWallet, RemoteWalletServer } from "@sig-net/midnight-wallet";

// Host side (runs wherever the wallet lives).
const server = new RemoteWalletServer(wallet);

// Client side: an in-process loopback stands in for a real transport here.
const remote = new RemoteWallet((method, request) => server.handle(method, request));
await remote.connect();
console.log(remote.getAddresses().unshielded);
```

The package ships one real transport, `createHttpRemoteWalletTransport`: one HTTP POST per call to `<baseUrl>/<method>` (so a base URL of `.../wallet/v1` yields routes like `/wallet/v1/handshake` and `/wallet/v1/getShieldedBalances`), bodies carrying the payload bytes verbatim, custom headers attached to every request. It runs on global `fetch`, so it works in Node 18+ and browsers. The path carries no version segment of its own: protocol compatibility is checked by the handshake, and a host that wants versioned routes puts the version in the base URL.

```ts
import { createHttpRemoteWalletTransport, RemoteWallet } from "@sig-net/midnight-wallet";

const remote = new RemoteWallet(
  createHttpRemoteWalletTransport(new URL("https://wallet-host.example/wallet/v1/"), {
    headers: { authorization: `Bearer ${token}` },
  }),
);
await remote.connect();
```

The matching HTTP server binding stays on the host's side of the fence (keeping `node:http` out of this browser-friendly package) and is a dozen lines:

```ts
import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import { RemoteWalletServer } from "@sig-net/midnight-wallet";

const walletServer = new RemoteWalletServer(wallet); // a ready, connected Wallet
createServer((request, response) => {
  void (async () => {
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
}).listen(8790);
```

## Related packages

- [`@sig-net/midnight`](https://www.npmjs.com/package/@sig-net/midnight): the client-agnostic protocol library.
- [`@sig-net/midnight-contract-deploy`](https://www.npmjs.com/package/@sig-net/midnight-contract-deploy): contract-deploy tooling built on this wallet.

Developed in [sig-net/midnight-integration](https://github.com/sig-net/midnight-integration). Example applications live in [sig-net/midnight-examples](https://github.com/sig-net/midnight-examples).
