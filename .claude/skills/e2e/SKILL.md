---
name: e2e
description: Run the integration e2e suite (packages/integration-tests) —
  reruns against kept contract addresses, or clean redeploys including
  derived-address fund sweeping and the fakenet MPC server hand-off. Use
  whenever running, re-running, or re-deploying the e2e stack.
---

# e2e — run the integration suite

This runbook is plain markdown on purpose: any agent or human can follow it,
not just Claude Code. The pipeline itself (the globalSetup steps + the flow
test files) is documented in `packages/integration-tests/README.md`; this
file is the *operational* knowledge around it. Setup (compile, deploy, key
and address derivation) runs in vitest globalSetup before ANY flow file —
including single-file runs — and flow files run one at a time in the order
pinned by `vitest.config.ts`.

## Modes

- **`/e2e`** (default) — rerun against the addresses already in `.env`.
- **`/e2e redeploy`** — the circuits changed (any `.compact` edit that alters
  a circuit, struct layout, or the request-id hash domain): full clean
  redeploy, below.

## Ground rules (violating these wastes 10+ minutes per mistake)

- Run the suite from the repo root: `npm run test:integration-tests` (all
  flows) or `npm run test:integration-tests:happy-day-e2e` (one flow; the
  setup pipeline still runs first).
- **Never set `STEP_THROUGH=1` in an unattended run** — it pauses for stdin
  between tests and hangs forever.
- A redeploy run zk-compiles two contracts (**~10 minutes of keygen**). Run
  the suite in the background, redirect output to a log file, and watch the
  log; do not sit on a foreground call with a 2-minute timeout.
- The suite is `vitest --bail 1`: it stops at the first failure, and on a
  fresh deploy a failure at the **funding preflight is expected**, not a bug
  (see the redeploy flow).
- Preflight minimums on `EVM_USER_ADDRESS` (Sepolia): **≥ 0.009 ETH** and
  **≥ 0.1 of `ERC20_ADDRESS`** (default Sepolia USDC
  `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`). The withdraw preflight
  additionally needs `EVM_VAULT_ADDRESS` to hold **≥ 0.003 ETH** (the vault's
  derived account pays the withdraw transfer's gas itself; its USDC comes
  from the suite's own deposit sweep).
- Every test from the deposit signature poll onward (both signature polls,
  broadcasts, the attestations, claim and withdraw settle) needs the
  **fakenet MPC responder running** with the CURRENT contract addresses (see
  hand-off below). If it is not running, the suite times out polling.

## Preconditions (both modes)

1. Local Midnight stack up: `docker compose up -d` at the repo root
   (node :9944, indexer :8088, proof server :6300).
2. `compact --version` works; `npm install` and `npm run compile` have run.
3. `.env` at the repo root exists (it also holds the fakenet
   `MPC_ROOT_KEY` and, in a comment, the Sepolia funding-wallet seed).

## Rerun flow (`/e2e`)

1. Confirm the MPC responder is running against the addresses in `.env`
   (`ps` for a `fakenet-signer` / `yarn response` process; its log prints
   `check midnight for SignBidirectionalEvents at <vault address>`).
   If not: start it — see step 6 of the redeploy flow.
2. `npm run test:integration-tests > <logfile> 2>&1 &` and watch the log.
   Expect all globalSetup steps to log `SKIPPED: …` and every flow file to
   pass (happy-day: 17/17) in ~5 min.

## Redeploy flow (`/e2e redeploy`)

**Why this is more than re-running:** `EVM_VAULT_ADDRESS` (path `"vault"`)
and `EVM_USER_ADDRESS` (path = user commitment hex) are epsilon-derived from
the **vault contract address**. A redeploy therefore moves both derived
accounts — the Sepolia funds on the old user address do NOT follow and must
be swept to the new one.

1. In `.env`, comment out all four:
   `MIDNIGHT_VAULT_CONTRACT_ADDRESS`, `MIDNIGHT_SIGNET_CONTRACT_ADDRESS`,
   `EVM_VAULT_ADDRESS`, `EVM_USER_ADDRESS`. Note the old vault contract
   address and old `EVM_USER_ADDRESS` — the sweep needs them.
2. Run the suite in the background. globalSetup zk-compiles (~10 min),
   deploys both contracts and derives the new addresses; the happy-day flow
   then initializes the vault and **fails at the funding preflight — this is
   the expected stopping point** (`--bail 1` cancels any later flow files).
3. Grep the log for the new values:
   `deployed a fresh MIDNIGHT_VAULT_CONTRACT_ADDRESS=…`,
   `deployed a fresh MIDNIGHT_SIGNET_CONTRACT_ADDRESS=…`,
   `derived a fresh EVM_VAULT_ADDRESS=…`, `derived a fresh EVM_USER_ADDRESS=…`
   (the final globalSetup banner also prints the complete `.env` block).
4. Sweep the old derived user account to the new one:

   ```sh
   set -a && source .env && set +a
   npx tsx .claude/skills/e2e/scripts/sweep-derived-funds.ts \
     --old-contract <OLD vault contract address> \
     --path <user commitment hex, printed as "caller commitment"> \
     --expect <OLD EVM_USER_ADDRESS> \
     --to <NEW EVM_USER_ADDRESS>
   ```

   The script derives the old account's key from `MPC_ROOT_KEY` (fakenet
   only), refuses to sign unless the derived address matches `--expect`, and
   moves the full ERC20 balance plus all ETH minus a gas reserve. If the old
   account holds nothing, fund the new address from the funding wallet whose
   seed is in the `.env` comment instead. Repeat with `--path vault` for the
   vault's own derived account (old → new `EVM_VAULT_ADDRESS`) if the old one
   still holds ETH; otherwise fund the new `EVM_VAULT_ADDRESS` with
   **≥ 0.003 ETH** from the funding wallet — the withdraw leg needs it for
   gas.
5. Write the four new values into `.env` (uncomment + replace).
6. MPC hand-off — in the `solana-signet-program` checkout:
   - set `MIDNIGHT_CONTRACT_ADDRESSES=<new vault contract address>` and
     `MIDNIGHT_SIGNET_CONTRACT_ADDRESS=<new signet contract address>` in its
     `.env`;
   - restart the responder: kill any running one, then `yarn response`
     (background, own log). Healthy startup logs
     `MidnightMonitor: nonce (none) -> 0 on <new vault address>`.
7. Rerun the suite (rerun flow). All setup steps skip; every flow file
   should pass (happy-day: 17/17).

## Reading failures

- `Failed Proof Server response … /check … 400` with
  `Inputs did not match alignment` in the proof-server docker logs: a
  circuit/runtime encoding disagreement. Known cause: a 1-variant enum in a
  `persistentHash`ed struct (`bytes(0)` atom — the compiler allocates one
  field element, the ledger parses zero). Keep every enum in hashed structs
  at ≥ 2 variants (`TxParamType` carries a `reserved` padding variant for
  exactly this).
- Preflight `expected 0 to be greater than or equal to …`: the derived user
  address is unfunded — you are mid-redeploy; continue from step 4.
- The signature-poll / attestation tests timing out while setup and the
  earlier contract calls pass: the MPC responder is down or watching stale
  contract addresses — redo step 6.
- `vault is already initialized` on a kept address is informational; the test
  still asserts state and passes.
