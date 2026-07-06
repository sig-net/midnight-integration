# ERC20 Vault Integration Tests

Everything that needs a **running stack** lives here — nowhere else in the
repo touches a network from tests. The suite drives the vault through
`@midnight-erc20-vault/cli`'s exported command functions (the cli owns the
orchestration; tests only sequence and assert), inspired directly by the old
repo's e2e Sepolia runbook.

## Prerequisites

- **Local Midnight stack**: `docker compose up -d` at the repo root (node,
  indexer, proof server — see `docker-compose.yaml`).
- **compact compiler** on PATH (`compact --version` must work).
- **`npm install` + `npm run compile`** from the repo root.
- **`SEPOLIA_RPC_URL`** set (funding preflights and, later, EVM broadcasts).
- For the full flow: the fakenet MPC responder from
  github.com/sig-net/solana-signet-program (`yarn response`) — the suite
  prints its exact configuration.

## Running

```sh
npm run test:integration-tests  # from the repo root
```

The suite is one ordered pipeline in `tests/e2e.test.ts` (`--bail 1` stops it
at the first failing step):

1. **env check** — stack reachable, compiler present, `SEPOLIA_RPC_URL` set.
2. **compile** (`compile:vault-contract:zk`) — skipped when
   `MIDNIGHT_VAULT_CONTRACT_ADDRESS` is set.
3. **deploy** (in-process `deployVault`) — skipped when the address is set;
   otherwise prints the address to save.
4. **derive `MPC_ROOT_KEY`** — skipped when set.
5. **derive MPC public keys** — skipped when all three are set.
6. **derive `EVM_VAULT_ADDRESS`** (path `"vault"`) — skipped when set.
7. **derive `EVM_USER_ADDRESS`** (path = user commitment hex) — skipped when
   set; this is the address you fund on Sepolia.
8. **print MPC server configuration** — always runs; also prints the full
   minimal `.env` block for subsequent runs.
9. **initialize** — drives the cli's `initialize` + `readState`; skips the
   circuit call (but still asserts) when the vault is already initialized.
10. **deposit funding preflight** — `EVM_USER_ADDRESS` must hold ≥ 0.01 ETH
    and ≥ 0.1 of the ERC20 (`ERC20_ADDRESS`, default Sepolia USDC). The
    deposit flow itself lands with the cli's `request-deposit` wiring.

Plain `npm run test` (root) skips the whole suite — it only runs when
`RUN_INTEGRATION_TESTS` is set, which `test:integration-tests` does for you.

## The two-phase workflow

A fresh run necessarily stops at the human hand-off: the MPC server can only
be configured with the contract address **after** the first run prints it.

- **Run 1** (fresh): compiles, deploys, derives everything, prints the
  MPC server config + the minimal `.env` block, initializes the vault, and
  fails the funding preflight until you fund the user address.
- **Between runs**: paste the printed block into `.env`, fund
  `EVM_USER_ADDRESS` (and `EVM_VAULT_ADDRESS` with gas ETH for withdrawals),
  configure + start the responder (`yarn response`).
- **Run 2+**: every setup step logs `SKIPPED: …` and the pipeline goes
  straight to the tests against the kept deployment.

## Environment variables

The suite loads the **repo-root `.env`** itself (nothing else in the repo
does); values already present in the real environment win over the file.

| Variable | Purpose | Default |
|---|---|---|
| `RUN_INTEGRATION_TESTS` | Opt-in gate; real env only (not read from `.env`), `test:integration-tests` sets it | unset (suite skips) |
| `NETWORK_ID`, `MIDNIGHT_NODE_*` | Midnight endpoints (lib config) | local stack defaults |
| `DEPLOYER_SEED` / `VAULT_DEPLOYER_SECRET_KEY` | Deployer wallet / identity | genesis seed `00…01` |
| `USER_SEED` / `VAULT_USER_SECRET_KEY` | User wallet / identity (cli) | genesis seed `00…01` |
| `MIDNIGHT_VAULT_CONTRACT_ADDRESS` | Deployed vault; set to skip compile+deploy | derived by run 1 |
| `MPC_ROOT_KEY` | Fakenet signer root key; set to skip generation | derived by run 1 |
| `MPC_JUBJUB_PK_X/Y`, `MPC_SECP256K1_PUBKEY` | MPC public keys; set all three to skip derivation | derived from root key |
| `EVM_VAULT_ADDRESS` / `EVM_USER_ADDRESS` | Derived EVM accounts; set to skip derivation | derived by run 1 |
| `SEPOLIA_RPC_URL` | EVM JSON-RPC endpoint | — (required) |
| `ERC20_ADDRESS` | Token for the deposit flow | Sepolia USDC `0x1c7D…7238` |

Note: the deployer and user identities default to the same genesis seed —
`initialize` is deployer-gated, so if you change one, change both (or expect
step 9 to be rejected in-circuit).

## Resetting local identity state

midnight-js persists private state in `midnight-level-db/` keyed by seed. If
you change `VAULT_USER_SECRET_KEY` while keeping the same `USER_SEED`, the
stale private state wins — `rm -rf midnight-level-db` to reset.
