# ERC20 Vault Integration Tests

Everything that needs a **running stack** lives here — nowhere else in the
repo touches a network from tests. One ordered pipeline
(`tests/e2e.test.ts`, 25 steps, `--bail 1`) drives the full deposit AND
withdraw round trip: compile → deploy → initialize → `requestDeposit` → the
MPC signs → the sweep transaction broadcasts on Sepolia → the attestation
lands back on Midnight → `claimDeposit` mints shielded vault tokens →
`requestWithdraw` escrows them → the MPC signs the vault→user transfer → it
broadcasts on Sepolia (the ERC20 leaves the vault). The cli owns the
orchestration; tests only sequence and assert.

## Prerequisites

- **Local Midnight stack**: `docker compose up -d` at the repo root
  (node :9944, indexer :8088, proof server :6300).
- **compact compiler** on PATH, then `npm install` + `npm run compile` from
  the root.
- **`EVM_RPC_URL`** set (repo-root `.env` — the suite loads it itself; real
  environment variables win over the file).
- For every step from the deposit signature poll onward: the fakenet MPC
  responder from
  [sig-net/solana-signet-program](https://github.com/sig-net/solana-signet-program)
  (`yarn response`) — the suite prints the exact config it needs.

## Running

```sh
npm run test:integration-tests   # from the repo root
```

Every setup step is **skippable via `.env`**: when its variable is set, the
step verifies it and logs `SKIPPED`, so a populated `.env` goes straight to
the contract calls (~2–3 min total). Unset, the step does the work and
prints the value to save. A fresh deployment is therefore **two runs by
design** — the MPC responder can only be configured after run 1 prints the
contract addresses:

1. **Run 1** — compiles with proving keys (~10 min: background it), deploys
   both contracts, derives keys and EVM addresses, initializes the vault,
   prints the complete `.env` block + responder config, then stops at the
   funding preflight. That stop is the hand-off, not a bug.
2. **Between runs** — paste the printed block into `.env`, fund
   `EVM_USER_ADDRESS` on Sepolia (≥ 0.009 ETH, ≥ 0.1 USDC) and
   `EVM_VAULT_ADDRESS` with ETH for the withdraw gas (≥ 0.003 ETH — the
   vault's derived account sends the withdraw transfer itself), configure
   and start the responder.
3. **Run 2** — every setup step skips; the deposit + withdraw flow runs to
   25/25.

**Redeploying after a circuit change?** The derived EVM accounts move with
the vault contract address, and funds on the old ones do not follow. Follow
the runbook in
[`../../.claude/skills/e2e/SKILL.md`](../../.claude/skills/e2e/SKILL.md) —
it includes the fund-sweep script.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `RUN_INTEGRATION_TESTS` | Opt-in gate (real env only, not `.env`); `test:integration-tests` sets it | unset (suite skips) |
| `EVM_RPC_URL` | EVM JSON-RPC endpoint | — (required) |
| `NETWORK_ID`, `MIDNIGHT_NODE_*` | Midnight endpoints (lib config) | local stack defaults |
| `DEPLOYER_SEED` / `VAULT_DEPLOYER_SECRET_KEY` | Deployer wallet / identity | genesis seed `00…01` |
| `USER_SEED` / `VAULT_USER_SECRET_KEY` | User wallet / identity (cli) | genesis seed `00…01` |
| `MIDNIGHT_VAULT_CONTRACT_ADDRESS`, `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` | Deployed contracts; set to skip compile+deploy | printed by run 1 |
| `MPC_ROOT_KEY` | Fakenet signer root key | derived by run 1 |
| `MPC_JUBJUB_PK`, `MPC_SECP256K1_PUBKEY` | MPC public keys | derived from root key |
| `EVM_VAULT_ADDRESS` / `EVM_USER_ADDRESS` | Epsilon-derived EVM accounts | derived by run 1 |
| `ERC20_ADDRESS` | Token for the deposit/withdraw flows | Sepolia USDC `0x1c7D…7238` |
| `DEPOSIT_REQUEST_ID` | Reuse an existing request id, skipping the `requestDeposit` call | unset |
| `WITHDRAW_REQUEST_ID` | Reuse an existing request id, skipping the `requestWithdraw` call | unset |
| `STEP_THROUGH` | `1` pauses before each test (hit enter) — interactive debugging only, never unattended | unset |

## Gotchas

- Deployer and user identities default to the **same** genesis seed;
  `initialize` is deployer-gated — change both or neither.
- midnight-js persists private state in `midnight-level-db/` keyed by seed.
  If you change `VAULT_USER_SECRET_KEY` under the same `USER_SEED`, the stale
  state wins — `rm -rf midnight-level-db` to reset.
- The signature-poll / attestation steps timing out while everything else
  passes means the MPC responder is down or watching stale contract
  addresses.
- Proof failures surface as `Failed Proof Server response … 400`; the real
  error is in `docker logs midnight-proof-server`.
