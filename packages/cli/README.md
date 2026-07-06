# Midnight ERC20 Vault CLI

The **example client** of the Midnight ERC20 vault: a node CLI showing how a
UI or any other program drives the vault end to end. It is also the client
under test — the integration tests exercise a deployed vault THROUGH this
package's exported command functions, exactly as a real client would, and
never re-implement the orchestration themselves.

Two ways to consume it:

- **As a CLI** — `npm run cli -- <command> [flags]` (from the repo root),
  configuration from the environment.
- **As a library** — import the command functions from
  `@midnight-erc20-vault/cli`; each command is one exported async function
  taking `(context, options)`. The `CliContext` carries the config, the
  vault's midnight-js providers, and the JOINED vault contract handle
  (`findDeployedContract` → `context.vault.callTx.<circuit>(...)`); build one
  with `createCliContext(config, { facade, keys })` inside lib's
  `withSyncedWalletFacade` — see the bottom of `src/main.ts` for the whole
  lifecycle in a dozen lines. The vault-specific pieces (compiled-contract
  binding, providers, witnesses) are `@midnight-erc20-vault/vault-contract`
  exports — the contract package is the SDK; this CLI just drives it.

## Commands

| Command | What it does | Status |
|---|---|---|
| `read-state` | Read the vault's public ledger via the typed `ledger()` decode: config + pending signature requests | wired |
| `initialize` | Deployer-only one-off: seal the vault's EVM address into the contract config (`callTx.initialize`) | wired |
| `request-deposit` | Record a deposit signature request on the vault's ledger; prints the request id | stubbed (routing constants) |
| `poll-signature-response` | Poll the signet contract for a request's MPC response | stubbed (placeholder record) |
| `broadcast-evm` | Broadcast an MPC-signed EVM transaction; prints the tx hash | stubbed (ethers pending) |
| `claim-deposit` | Verify the MPC attestation in-circuit and mint shielded vault tokens | stubbed (circuit not ported) |
| `deposit-e2e` | Full deposit orchestration (see below) | partial |
| `request-withdraw` | Escrow a shielded coin and record a withdraw signature request | stubbed (circuit not ported) |
| `refund-withdraw` | Settle a withdraw: success is final, failure re-mints the escrow to the refund recipient | stubbed (circuit not ported) |
| `withdraw-e2e` | Full withdraw orchestration (see below) | stubbed |

Every command runs inside a wallet session and a joined vault contract (see
**Running**). Stubbed commands validate their inputs, print what they would
do, then throw `NotImplementedError` naming the missing piece. See **Status**
below.

## The deposit flow (`deposit-e2e`)

Deposit moves ERC20 into the vault on the EVM chain and mints shielded vault
tokens on Midnight. Every MPC hand-off is **polled from the
signet contract** — there is no push channel.

1. **`request-deposit`** calls the vault's `requestDeposit` circuit (ZK proof
   via the proof server). The circuit binds the request to the caller's
   identity commitment, stores the full signature request in the vault's
   public ledger, and the request id is the domain-separated hash of the
   whole record.
2. The **MPC network** — which watches the vault's raw ledger state via the
   indexer, needing only the contract address — decodes the request,
   assembles the EVM sweep transaction (ERC20 `transfer` from the USER's
   derived EVM address into the vault's EVM address), signs it with the key
   derived from `(contract address, path)`, and posts the **signed
   transaction** to the signet contract.
3. **`poll-signature-response`** picks the signed transaction up;
   **`broadcast-evm`** sends it to the EVM chain.
4. The MPC observes the EVM receipt and posts a **Schnorr-signed
   `(requestId, outputData)` attestation** of the result to the
   signet contract; `poll-signature-response` picks it up.
5. **`claim-deposit`** calls the vault's `claimDeposit` circuit, which
   verifies the MPC public key hash, the Schnorr signature, the EVM success
   flag, and the caller's identity against the stored request — then mints
   shielded vault tokens to the caller.

The user's derived EVM address (step 2's sender) must hold the ERC20 amount
plus gas beforehand; the derivation path IS the caller's identity commitment
hex, so identity, path, and derived EVM account are bound 1:1.

## The withdraw flow (`withdraw-e2e`)

Withdraw surrenders shielded vault tokens on Midnight and pays out ERC20 from
the vault's EVM address. Optimistic with escrow + refund:

1. **`request-withdraw`** calls the vault's `requestWithdraw` circuit: the
   shielded coin is escrowed UP FRONT, a refund recipient is pinned, and the
   signature request is recorded with `path = "vault"` — so the MPC signs
   from the VAULT's derived EVM address, not the user's.
2. The MPC signs the vault→destination ERC20 `transfer` and posts it to the
   signet contract; `poll-signature-response` + `broadcast-evm` as above.
3. The MPC posts the Schnorr-signed attestation of the EVM result.
4. **`refund-withdraw`** settles the request in either direction: on EVM
   success the withdrawal is final; on failure the escrowed value is
   re-minted to the pinned refund recipient. The call is permissionless —
   anyone may settle, the refund always goes to the pinned recipient.

## Configuration

All configuration comes from the environment. The Midnight endpoints are
read by `@midnight-erc20-vault/lib` (one shared parser for the whole repo);
the rest is CLI-specific.

| Variable | Meaning | Default |
|---|---|---|
| `NETWORK_ID` | `undeployed` \| `preview` \| `preprod` \| `mainnet` | `undeployed` |
| `MIDNIGHT_NODE_URL`, `MIDNIGHT_NODE_INDEXER_URL`, `MIDNIGHT_NODE_INDEXER_WS_URL`, `MIDNIGHT_NODE_PROOF_SERVER_URL` | Endpoint overrides | per-network defaults |
| `USER_SEED` | Wallet seed (hex or mnemonic) paying for Midnight transactions | local-stack genesis mint wallet |
| `VAULT_USER_SECRET_KEY` | 32-byte hex vault identity secret (answers the `callerSecretKey` witness) | the seed bytes |
| `MIDNIGHT_VAULT_CONTRACT_ADDRESS` | Deployed ERC20 vault contract on Midnight | — |
| `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` | Deployed signet contract on Midnight | — |
| `EVM_RPC_URL` | JSON-RPC endpoint of the EVM chain | — |
| `EVM_CHAIN_ID` | EVM chain id (also yields the CAIP-2 routing id `eip155:<id>`) | — |
| `ERC20_ADDRESS` | The ERC20 token the vault holds | — |

For `initialize`, set `VAULT_USER_SECRET_KEY` to the DEPLOYER's secret — the
circuit is gated to the identity whose commitment was sealed at deploy time.

## Running

```sh
# from the repo root
npm run cli -- --help
npm run cli -- read-state
npm run cli -- request-deposit --amount 1 --evm-nonce 0
npm run cli -- deposit-e2e --amount 1 --evm-nonce 0 --interval-ms 5000 --timeout-ms 300000
```

Prerequisites once the commands are wired: `npm run compile:zk` output for the
vault (proving keys), a running Midnight stack (node, indexer, proof server),
deployed vault + signet contracts, and a funded wallet.

## Status

The wallet session, vault providers, contract join, `read-state`, and
`initialize` are fully wired (pending a run against a live stack). Still
missing, in dependency order:

1. **The MPC routing constants + codec** (keyVersion, algo, dest, schemas,
   gas defaults) ported from the MVP — needed by `request-deposit` to
   construct the signet request arguments; the circuit call itself is one
   `context.vault.callTx.requestDeposit(...)` away.
2. **The real response record in the signet contract** — the
   current placeholder stores 32 bytes per request, which cannot carry a
   signed EVM transaction or a Schnorr attestation. Blocks `poll-signature-response`
   (and joining the responses contract into the context).
3. **Vault circuits `claimDeposit`, `requestWithdraw`, `refundWithdraw`** —
   not yet ported from the MVP.
4. **`ethers`** for `broadcast-evm` — added when that command is wired.
