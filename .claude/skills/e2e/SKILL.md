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

- Run the suite from the repo root: `yarn test:integration-tests` (all
  flows) or `yarn test:integration-tests:happy-day-e2e` (one flow; the
  setup pipeline still runs first).
- **Never set `STEP_THROUGH=1` in an unattended run** — it pauses for stdin
  between tests and hangs forever.
- A redeploy run zk-compiles two contracts (**~10 minutes of keygen**). Run
  the suite in the background, redirect output to a log file, and watch the
  log; do not sit on a foreground call with a 2-minute timeout.
- The suite is `vitest --bail 1`: it stops at the first failure, and on a
  fresh deploy a failure is expected, not a bug (see the redeploy flow): on
  Sepolia at the **funding preflight**; on the local EVM (funding is
  automatic) at the **deposit signature-poll timeout** instead.
- Preflight minimums on `EVM_USER_ADDRESS` (Sepolia): **≥ 0.009 ETH** and
  **≥ 0.1 of `ERC20_ADDRESS`** (default Sepolia USDC
  `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`). The withdraw preflight
  additionally needs `EVM_VAULT_ADDRESS` to hold **≥ 0.003 ETH** (the vault's
  derived account pays the withdraw transfer's gas itself; its USDC comes
  from the suite's own deposit sweep). The failure-refund flow enforces the
  same minimums and sends two more vault-account transactions (the
  fakenet-only ERC20 drain, then the deliberately reverting transfer), so
  the vault's ETH drifts down a little faster when it runs; its ERC20
  balance ends at zero BY DESIGN (the drain returns it to
  `EVM_USER_ADDRESS`).
- Every test from the deposit signature poll onward (both signature polls,
  broadcasts, the attestations, claim and withdraw settle) needs the
  **fakenet MPC responder running** with the CURRENT contract addresses (see
  hand-off below). If it is not running, the suite times out polling.

## Preconditions (both modes)

1. Local Midnight stack up: `docker compose up -d` at the repo root
   (node :9944, indexer :8088, proof server :6300).
2. `compact --version` works; `yarn install` and `yarn compile` have run.
3. `.env` at the repo root exists (it also holds the fakenet
   `MPC_ROOT_KEY` and, in a comment, the Sepolia funding-wallet seed).
4. If the EVM endpoint is the local chain: the `evm` compose service
   (anvil) is up — part of the same `docker compose up -d` as the Midnight
   stack (probe with `curl -s http://127.0.0.1:8545`). The endpoint is the
   one deliberately duplicated `.env` pair, both pointing at the SAME
   chain: `VITE_TEST_EVM_RPC_URL` (host-side tests; mapped onto the
   pipeline's internal `EVM_RPC_URL` key at env load) and
   `FAKENET_EVM_RPC_URL` (the fakenet container; defaults to the in-network
   `http://evm:8545` when unset — loopback in-container is the container
   itself, hence the split). Local anvil needs only
   `VITE_TEST_EVM_RPC_URL=http://127.0.0.1:8545`. Setup then deploys
   TestUSDC when missing and auto-funds the derived accounts. Restarting
   the container wipes the EVM chain (in-memory state); setup detects that
   and redeploys.

## Rerun flow (`/e2e`)

1. Confirm the MPC responder is running against the addresses in `.env`
   (`docker ps` for the `fakenet-responder` container;
   `docker logs fakenet-responder` prints
   `MidnightMonitor: polling signet contract registry at <signet address>`.
   A locally run `yarn response` process — `ps` — also counts, for responder
   development). If not: start it — see step 6 of the redeploy flow.
2. `yarn test:integration-tests > <logfile> 2>&1 &` and watch the log.
   Expect all globalSetup steps to log `SKIPPED: …` and every flow file to
   pass (happy-day: 15/15, deposit-withdrawal-failure-refund: 9/9,
   deposit-claimant-not-caller: 6/6, benchmark: 13/13, false-claimer: 6/6).
   Single-file scripts: `yarn test:integration-tests:<flow-file-name>`,
   e.g. `yarn test:integration-tests:happy-day-e2e`
   (globalSetup still runs first either way).

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
   **Local EVM variant:** funding is automatic, so the run instead proceeds
   through `deposit` and stops at the signature-poll timeout; skip
   step 4 entirely (no sweep — the new derived accounts are topped up by
   setup on the next run) and optionally note the printed
   `DEPOSIT_REQUEST_ID` to resume that request in step 7.
3. Grep the log for the new values:
   `deployed a fresh MIDNIGHT_VAULT_CONTRACT_ADDRESS=…`,
   `deployed a fresh MIDNIGHT_SIGNET_CONTRACT_ADDRESS=…`,
   `derived a fresh EVM_VAULT_ADDRESS=…`, `derived a fresh EVM_USER_ADDRESS=…`
   (the final globalSetup banner also prints the complete `.env` block).
4. Sweep the old derived user account to the new one:

   ```sh
   set -a && source .env && set +a
   yarn tsx .claude/skills/e2e/scripts/sweep-derived-funds.ts \
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
6. MPC hand-off — the `fakenet` compose service
   (`ghcr.io/sig-net/fakenet:latest`, built from
   sig-net/solana-signet-program, running Midnight-only via
   `DISABLE_SOLANA`):
   - step 5 already put the new `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` (and
     `MPC_ROOT_KEY`) in this repo's `.env` — compose interpolates the
     service's environment from it (the responder discovers requester
     contracts by watching the signet contract's notification registry — no
     vault address needed);
   - start/recreate the container:
     `docker compose --profile fakenet up -d --force-recreate fakenet`.
     `--force-recreate` is required after a redeploy: it re-reads `.env` AND
     resets the container-local LevelDB private state. Healthy startup
     (`docker logs -f fakenet-responder`) prints
     `MidnightMonitor: polling signet contract registry at <new signet address>`;
   - prover/verifier parity: the image proves its posts with the signet
     zk keys from the published `@sig-net/midnight-contract` npm package
     (the tarball DOES ship the provers). That is correct as long as the
     deployed signet contract came from the same published package. If you
     recompiled `packages/signet-contract` with DIFFERENT keys and deployed
     that, every post fails verification — publish the package and re-release
     the image, or (local iteration) uncomment the `volumes:` bind-mount on
     the `fakenet` service in `docker-compose.yaml` to overlay
     `./packages/signet-contract/src/managed` (verify verifier shasums match
     the deployed contract);
   - fallback for responder development: `yarn response` in a
     `solana-signet-program` checkout with the new signet address in its
     `.env`.
7. Rerun the suite (rerun flow). All setup steps skip; every flow file
   should pass (happy-day: 15/15).

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
- The signature poll timing out on a request the responder DID log as "New
  request", with `postSignatureResponse … FAILED` + a proof-server transport
  error in the responder's own log (`docker logs fakenet-responder`): the
  responder proves its posts through the SAME proof server (:6300), and a
  proof-server restart during its post kills it — the responder does not
  retry, so the request strands unresponded. Recover by restarting the
  responder (`docker compose --profile fakenet restart fakenet` — a plain
  restart is enough here, no recreate needed; its startup backfill
  re-discovers unresponded requests and posts the missing signatures), then
  rerun the flow file with its resume var. Corollary: when restarting the
  proof server between flow files for OOM headroom, do it only while the
  responder's log is quiet — and "quiet" means no in-flight post (every
  `postSignatureResponse/postRespondBidirectional … started` line has its
  `took Ns`/`FAILED` twin), NOT an unchanged log: the idle poll loop writes
  every few seconds, so raw log growth never stops.
- Expect the OOM at the CLAIM leg of every flow file that runs a full
  deposit round trip in one pass (arrange or long-hand alike): by the time
  the claim proves, the same proof server has already served the deposit
  proof plus the responder's two posts, and the claim tips it over even from
  a fresh restart at file start. The reliable cadence on a 16 GB Docker VM
  is: let the file OOM at claim, `docker restart midnight-proof-server`,
  rerun the SAME file with its resume var — the claim is then the FIRST
  proof on a fresh server and the rest of the file (withdraw, settle)
  fits in the remaining headroom.
- `connect ECONNREFUSED 127.0.0.1:6300` mid-claim/settle with
  `docker ps -a` showing the proof server `Exited (137)`: the proof server
  was OOM-killed (it has done this repeatedly at the claim step — a single
  claim/settle proof peaks at ~8–10 GiB inside the Docker VM, so with the
  default 16 GB VM one heavy proof under host memory pressure is enough;
  `docker restart midnight-proof-server` between flow files buys headroom,
  since each flow file starts with a proving-free window). Recover
  with `docker start midnight-proof-server`, then rerun the SAME flow file
  resuming its pending request instead of spending another deposit —
  happy-day: `DEPOSIT_REQUEST_ID=<id>` / `WITHDRAW_REQUEST_ID=<id>`;
  failure-refund: `FAILURE_REFUND_DEPOSIT_REQUEST_ID=<id>` /
  `FAILURE_REFUND_WITHDRAW_REQUEST_ID=<id>` (each file prints its ids as it
  goes; `broadcastEvm` is idempotent, so already-mined transfers skip
  through).
