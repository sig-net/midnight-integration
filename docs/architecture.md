# Architecture

Demonstrates sig-net cross-chain interactions from Midnight. The ERC20 vault is the
first example: a Midnight contract owns an EVM account (derived via sig-net MPC) and
moves ERC20 funds on Ethereum by having the MPC network sign EVM transactions it
requests.

## The full flow

1. **Fund derived account** — the vault's EVM address is derived from the MPC root
   public key; the user funds it (ERC20 + gas).
2. **`deposit()`** — user calls the vault contract on Midnight; it records a pending
   signature request for the EVM transfer.
3. **MPC signs** — the sig-net MPC network observes the request and produces a
   secp256k1 signature over the EVM transaction.
4. **`postResponse()`** — the MPC posts the signature onto the
   signature-responses contract (Midnight); clients poll this contract (the old
   websocket path is gone, no fallback).
5. **Watcher submits EVM tx** — a watcher assembles the signed transaction and
   broadcasts it to Ethereum.
6. **MPC confirms** — the MPC observes EVM finality and produces a Schnorr (Jubjub)
   response attesting the outcome.
7. **`claim()`** — the user presents the Schnorr response to the vault contract to
   finalise the deposit.

<!-- TODO(port): expand each step with the concrete circuit/ledger fields once the
     contracts are ported. -->
<!-- TODO(port): diagram — Midnight contracts / MPC / EVM lanes. -->
<!-- TODO(port): withdraw + completeWithdraw flow (mirror of deposit/claim). -->
