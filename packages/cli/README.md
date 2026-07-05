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
  taking `(context, options)`, where the `CliContext` (built by
  `createCliContext(config)`) carries the config plus lazy access to the
  connected resources: the indexer public-data provider and the joined vault
  contract handle (midnight-js `findDeployedContract` →
  `vault.callTx.<circuit>(...)`). `src/main.ts` is only a thin commander
  shell over them.

## Commands

| Command | What it does | Status |
|---|---|---|
| `read-state` | Decode the vault's pending signature requests (ledger field 0) from raw indexer state — the same MPC-convention read the monitor uses; no compiled contract needed | stubbed |
| `initialize` | Deployer-only one-off: seal the vault's EVM address into the contract config | stubbed |
| `request-deposit` | Record a deposit signature request on the vault's ledger; prints the request id | stubbed |
| `poll-response` | Poll the signature-responses contract for a request's MPC response | stubbed |
| `broadcast-evm` | Broadcast an MPC-signed EVM transaction; prints the tx hash | stubbed |
| `claim-deposit` | Verify the MPC attestation in-circuit and mint shielded vault tokens | stubbed (circuit not ported) |
| `deposit-e2e` | Full deposit orchestration (see below) | stubbed |
| `request-withdraw` | Escrow a shielded coin and record a withdraw signature request | stubbed (circuit not ported) |
| `refund-withdraw` | Settle a withdraw: success is final, failure re-mints the escrow to the refund recipient | stubbed (circuit not ported) |
| `withdraw-e2e` | Full withdraw orchestration (see below) | stubbed |

Stubbed commands parse their arguments, load config, derive the caller
identity, print what they would do, then throw `NotImplementedError` naming
the missing piece. See **Status** below for what is missing and why.

## The deposit flow (`deposit-e2e`)

Deposit moves ERC20 into the vault on the EVM chain and mints shielded vault
tokens on Midnight. Every MPC hand-off is **polled from the
signature-responses contract** — there is no push channel.

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
   transaction** to the signature-responses contract.
3. **`poll-response`** picks the signed transaction up;
   **`broadcast-evm`** sends it to the EVM chain.
4. The MPC observes the EVM receipt and posts a **Schnorr-signed
   `(requestId, outputData)` attestation** of the result to the
   signature-responses contract; `poll-response` picks it up.
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
   signature-responses contract; `poll-response` + `broadcast-evm` as above.
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
| `VAULT_CONTRACT_ADDRESS` | Deployed ERC20 vault contract on Midnight | — |
| `RESPONSES_CONTRACT_ADDRESS` | Deployed signature-responses contract on Midnight | — |
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
deployed vault + signature-responses contracts, and a funded wallet.

## Status

The package is a **skeleton**: the command surface, configuration, identity
derivation, and the command logic itself are real; the `CliContext`'s
connected-resource getters throw `NotImplementedError`. What is missing, in
dependency order:

1. **midnight-js provider plumbing in `packages/lib`** — the provider set
   (indexer public-data / proof-server / zk-config / private-state store)
   plus the WalletFacade → WalletProvider/MidnightProvider adapter, so the
   context can `findDeployedContract` and commands can call
   `vault.callTx.<circuit>(...)` (which balances, proves, and submits —
   coin-bearing calls included). Blocks everything that touches the chain.
2. **The MPC routing constants + codec** (keyVersion, algo, dest, schemas,
   gas defaults) ported from the MVP — needed by `request-deposit` to
   construct the signet request arguments.
3. **The real response record in the signature-responses contract** — the
   current placeholder stores 32 bytes per request, which cannot carry a
   signed EVM transaction or a Schnorr attestation. Blocks `poll-response`.
4. **Vault circuits `claimDeposit`, `requestWithdraw`, `refundWithdraw`** —
   not yet ported from the MVP.
5. **`ethers`** for `broadcast-evm` — added when that command is wired.
