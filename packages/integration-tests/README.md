# ERC20 Vault Integration Tests

Everything that needs a **running stack** lives here — nowhere else in the
repo touches a network from tests. The pipeline has two halves:

- **Setup** (`src/setup/`, run by vitest **globalSetup** — see
  `vitest.config.ts`): environment preflight → MPC key derivation →
  zk-compile + deploy the signet and vault contracts → derive the EVM
  addresses → print the MPC hand-off banner. Runs ONCE in vitest's main
  process before ANY test file, including single-file runs. Every step skips
  itself when its env var is already set.
- **Flow files** (`tests/*.test.ts`, `--bail 1`), one at a time in the order
  pinned by `FILE_ORDER` in `vitest.config.ts` — they share chain state, one
  MPC responder, and EVM nonces/funds, so they can never run in parallel:
  - `happy-day-e2e.test.ts` — the full deposit AND withdraw round trip:
    initialize → `requestDeposit` → the MPC signs → the sweep transaction
    broadcasts on Sepolia → the attestation lands back on Midnight →
    `claimDeposit` mints shielded vault tokens → `requestWithdraw` escrows
    them → the MPC signs the vault→user transfer → it broadcasts on Sepolia
    (the ERC20 leaves the vault).
  - `deposit-withdrawal-failure-refund.test.ts` — the refund branch: a
    deposit round trip arranges shielded tokens (via `src/flows/deposit.ts`),
    a fakenet-only drain empties the vault's EVM ERC20 balance, then a
    withdraw whose transfer mines and REVERTS drives the MPC's failure
    attestation into `completeWithdraw`'s in-circuit refund. The drain sends
    the vault's ERC20 back to `EVM_USER_ADDRESS`, so EVM funds keep cycling.
  - `deposit-claimant-not-caller.test.ts` — the optional claim recipient: a
    deposit round trip claims with `recipient` set to a SECOND wallet's coin
    public key, and that wallet — synced fresh from its own seed — must see
    the minted shielded vault tokens in its balance. Ends with the same
    fakenet-only drain (the claimed tokens strand on the recipient), so EVM
    funds keep cycling.

The cli owns the orchestration; tests only sequence and assert — reusable
sequences live in `src/flows/` (deposit round trip, withdraw legs). To add a
flow file (benchmark, false-claimer…), start from
[`src/flows/TODO.md`](src/flows/TODO.md) — it is a self-contained work
order, including the three registration points every new file must touch.

## Prerequisites

- **Local dev stack**: `docker compose up -d` at the repo root — Midnight
  (node :9944, indexer :8088, proof server :6300) plus the `evm` service
  (anvil, :8545, chain id 31337).
- **compact compiler** on PATH, then `yarn install` + `yarn compile` from
  the root.
- **An EVM chain via `EVM_RPC_URL`** (repo-root `.env` — the suite loads it
  itself; real environment variables win over the file). Two options:
  - **Sepolia** — a real endpoint (e.g. Infura); derived accounts need
    manual funding (see Running).
  - **The local `evm` compose service** — set
    `EVM_RPC_URL=http://127.0.0.1:8545`; that is the ONLY required change.
    Setup detects the local chain (id 31337), deploys
    `contracts/TestUSDC.sol` when `ERC20_ADDRESS` has no code (hardhat is
    the Solidity compiler; the node is anvil — interchangeable for these
    flows), and auto-funds both derived accounts (10 ETH + 1000 USDC each).
- For every step from the deposit signature poll onward: the fakenet MPC
  responder from
  [sig-net/solana-signet-program](https://github.com/sig-net/solana-signet-program)
  (`yarn response`) — the suite prints the exact config it needs. On the
  local loop, set `EVM_RPC_URL=http://127.0.0.1:8545` in the responder's
  env too, so it signs/verifies against the SAME local chain.

## Running

```sh
yarn test:integration-tests                 # all flow files, from the repo root
yarn test:integration-tests:happy-day-e2e   # just the happy-day flow
yarn test:integration-tests:deposit-withdrawal-failure-refund   # just the refund flow
yarn test:integration-tests:deposit-claimant-not-caller   # just the alternate-recipient claim flow
```

Selecting a single flow file still runs the globalSetup pipeline first —
setup is never skipped by narrowing the selection. Each flow file follows
the naming convention: `tests/<name>.test.ts` ↔ root script
`test:integration-tests:<name>`.

Every setup step is **skippable via `.env`**: when its variable is set, the
step verifies it and logs `SKIPPED`, so a populated `.env` goes straight to
the contract calls (~2–3 min total). Unset, the step does the work and
prints the value to save. A fresh deployment is therefore **two runs by
design** — the MPC responder can only be configured after run 1 prints the
contract addresses:

1. **Run 1** — globalSetup compiles with proving keys (~10 min: background
   it), deploys both contracts (and, on the local chain, the TestUSDC
   token), derives keys and EVM addresses, and prints the complete `.env`
   block + responder config; the happy-day flow then initializes the vault
   and stops (later flow files are cancelled by `--bail 1`). On Sepolia the
   stop is the funding preflight; on the local chain funding is automatic,
   so the flow proceeds through `requestDeposit` and stops at the
   signature-poll timeout (~1 min) instead. Either stop is the hand-off,
   not a bug.
2. **Between runs** — paste the printed block into `.env`. On Sepolia, fund
   `EVM_USER_ADDRESS` (≥ 0.009 ETH, ≥ 0.1 USDC) and `EVM_VAULT_ADDRESS`
   with ETH for the withdraw gas (≥ 0.003 ETH — the vault's derived account
   sends the withdraw transfer itself); on the local chain skip funding
   entirely. Configure and start the responder. On the local chain,
   optionally set `DEPOSIT_REQUEST_ID` from run 1's printout so run 2
   resumes the already-recorded request instead of creating a fresh one.
3. **Run 2** — every setup step skips (the ERC20 step by finding code
   on-chain, funding by the balances already meeting their targets); every
   flow file runs to the end (happy-day: 17/17, failure-refund: 9/9,
   claimant-not-caller: 5/5).

**Redeploying after a circuit change?** The derived EVM accounts move with
the vault contract address, and funds on the old ones do not follow. Follow
the runbook in
[`../../.claude/skills/e2e/SKILL.md`](../../.claude/skills/e2e/SKILL.md) —
it includes the fund-sweep script.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `RUN_INTEGRATION_TESTS` | Opt-in gate (real env only, not `.env`); `test:integration-tests` sets it | unset (suite skips) |
| `EVM_RPC_URL` | EVM JSON-RPC endpoint (Sepolia or the local hardhat node) | — (required) |
| `EVM_CHAIN_ID` | Chain id, sealed into the vault at initialize | resolved from the RPC; verified when set |
| `NETWORK_ID`, `MIDNIGHT_NODE_*` | Midnight endpoints (lib config) | local stack defaults |
| `DEPLOYER_SEED` / `VAULT_DEPLOYER_SECRET_KEY` | Deployer wallet / identity | genesis seed `00…01` |
| `USER_SEED` / `VAULT_USER_SECRET_KEY` | User wallet / identity (cli) | genesis seed `00…01` |
| `MIDNIGHT_VAULT_CONTRACT_ADDRESS`, `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` | Deployed contracts; set to skip compile+deploy | printed by run 1 |
| `MPC_ROOT_KEY` | Fakenet signer root key | derived by run 1 |
| `MPC_JUBJUB_PK`, `MPC_SECP256K1_PUBKEY` | MPC public keys | derived from root key |
| `EVM_VAULT_ADDRESS` / `EVM_USER_ADDRESS` | Epsilon-derived EVM accounts | derived by run 1 |
| `ERC20_ADDRESS` | Token for the deposit/withdraw flows | Sepolia USDC `0x1c7D…7238` on Sepolia; auto-deployed TestUSDC on the local chain |
| `DEPOSIT_REQUEST_ID` | Happy-day: reuse an existing request id, skipping the `requestDeposit` call | unset |
| `WITHDRAW_REQUEST_ID` | Happy-day: reuse an existing request id, skipping the `requestWithdraw` call | unset |
| `FAILURE_REFUND_DEPOSIT_REQUEST_ID` | Failure-refund: resume the arrange deposit from an existing request id | unset |
| `FAILURE_REFUND_WITHDRAW_REQUEST_ID` | Failure-refund: resume the doomed withdraw from an existing request id | unset |
| `DEPOSIT_CLAIMANT_NOT_CALLER_DEPOSIT_REQUEST_ID` | Claimant-not-caller: resume the deposit from an existing request id | unset |
| `STEP_THROUGH` | `1` pauses before each setup step and each test (hit enter) — interactive debugging only, never unattended | unset |

## Gotchas

- Deployer and user identities default to the **same** genesis seed;
  `initialize` is deployer-gated — change both or neither.
- midnight-js persists private state in `midnight-level-db/` keyed by seed.
  If you change `VAULT_USER_SECRET_KEY` under the same `USER_SEED`, the stale
  state wins — `rm -rf midnight-level-db` to reset.
- The signature-poll / attestation steps timing out while everything else
  passes means the MPC responder is down or watching stale contract
  addresses.
- Restarting the local `evm` container wipes the EVM chain (anvil state is
  in-memory) while Midnight state survives — shielded vault tokens minted
  under the old `ERC20_ADDRESS` are
  domain-separated by it and would strand. In practice the redeploy lands on
  the SAME address (first tx of the well-known funder, nonce 0), so kept
  `.env` values and shielded balances stay coherent; only in-flight request
  ids (a broadcast-but-unclaimed deposit) become unusable — drop the resume
  vars and let the flow create fresh requests.
- Proof failures surface as `Failed Proof Server response … 400`; the real
  error is in `docker logs midnight-proof-server`.
- In the `test:integration` script, `--bail 1` must stay LAST: the
  single-file scripts append their `tests/<name>.test.ts` filter after it,
  and a trailing BOOLEAN flag (`--disable-console-intercept`) would swallow
  that filter as its value — vitest then silently runs EVERY flow file.
