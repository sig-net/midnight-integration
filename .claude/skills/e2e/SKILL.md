---
name: e2e
description: Run the integration e2e suite (packages/integration-tests), the
  signet-caller flows (generic and real-EVM) against the local docker stack.
  From a fresh clone to a green suite, reruns against kept contract
  addresses, or clean redeploys after a circuit change, including the
  fakenet MPC responder hand-off. Use whenever running, re-running, or
  re-deploying the e2e stack.
---

# e2e: run the integration suite

This runbook is plain markdown on purpose: any agent or human can follow it.
The pipeline itself (the globalSetup steps + the flow
file) is documented in `packages/integration-tests/README.md`. This file is
the *operational* knowledge around it. Setup (MPC keys, dust preflight,
compile, deploy, fakenet hand-off) runs in vitest globalSetup before ANY
test, including single-file runs.

The default run covers TWO flow files: the generic flow (EVM-free: its
request exists to be SIGNED, never broadcast, 5 online tests) and the
real-EVM flow (15 online tests), which broadcasts the MPC-signed
transactions on the compose `evm` service (anvil, :8545) and fetches raw
execution outputs from the fakenet's public `/responses/{requestId}` helper
API on :3040.

## Fresh-clone quickstart (zero to green)

```sh
corepack enable
yarn install
compact update 0.33.0-rc.2   # NEVER a bare `compact update`: see ground rules
yarn compile                 # run before the suites
docker compose up -d          # node :9944, indexer :8088, proof server :6300, anvil :8545
cd <repo-root>
yarn test:integration-tests > /tmp/caller-e2e.log 2>&1 &
```

Watch the log. No pre-existing `.env` is required: the setup creates it when
it appends the fakenet hand-off values (`MPC_ROOT_KEY`,
`MIDNIGHT_SIGNET_CONTRACT_ADDRESS`). Appends never modify existing lines,
and a value that conflicts with the shell environment is a hard error, never
an overwrite. The first run zk-compiles BOTH contracts (~10–25 min of
keygen, machine-dependent: background the run and never diagnose a hang
from duration alone), deploys them, starts the responder mid-setup, and the
flow files run to the end (generic flow 5/5, real-EVM flow 15/15). Save the
printed
`MIDNIGHT_CALLER_CONTRACT_ADDRESS` into `.env` so the next run skips
compile + deploy (the signet address is appended automatically).

## Modes

- **`/e2e`** (default): rerun against the addresses already in `.env`.
  Every skippable setup step logs `SKIPPED`, only the flow runs (~2 min).
- **`/e2e redeploy`**: a circuit changed (any `.compact` edit that alters a
  circuit, struct layout, or the request-id hash domain): comment out
  `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` and `MIDNIGHT_CALLER_CONTRACT_ADDRESS`
  in `.env` (delete the appended signet line or comment it), then run as in
  the quickstart. The setup re-keygens, redeploys, and **recreates the
  responder itself** (`--force-recreate` exactly when hand-off values newly
  land in `.env`: that re-reads `.env` AND resets the responder's LevelDB
  private state). One run, no manual hand-off. There are no funded derived
  accounts to sweep on the local loop. The parked Sepolia sweep procedure
  lives in `docs/e2e-sepolia-runbook.md` + `scripts/sweep-derived-funds.ts`.

## Ground rules (violating these wastes 10+ minutes per mistake)

- Run from the repo root: `yarn test:integration-tests` (or the file-scoped
  `yarn test:integration-tests:signet-caller-e2e`, the setup pipeline runs
  first either way).
- **NEVER run a bare `compact update`** while no ≥0.33 stable exists: it
  installs (and DOWNGRADES an active rc default to) stable 0.31.1, whose
  language 0.23 rejects the contracts' `pragma language_version >= 0.25`.
  Use `compact update 0.33.0-rc.2`. If the launcher's channel refuses the
  rc, use the direct-download recipe in `.github/workflows/ci.yml`.
- Background any run that may zk-compile: redirect to a log file and watch
  it. Never sit on a foreground call with a 2-minute timeout.
- **Never set `STEP_THROUGH=1` in an unattended run**: it pauses for stdin
  before every step/test and hangs forever.
- `TRUST_PREBUILT_ZK_KEYS=1` is CI-only (its key cache is keyed on the
  contract sources). Locally, stale prover keys poison deploys: let the
  address-var skip logic decide instead.
- The suite is `vitest --bail 1`: it stops at the first failure. vitest's
  `No test files found, exiting with code 1` after a failure means
  globalSetup THREW: read the `Unhandled Error` block below it, not the
  test-discovery message.

## Fakenet responder hand-off

The setup manages the responder by default: after deploying the signet
contract it appends `MPC_ROOT_KEY` + `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` to
`.env` (docker compose interpolates the `fakenet` service's environment from
that file) and runs
`docker compose --profile fakenet up -d [--force-recreate] fakenet`
(`ghcr.io/sig-net/fakenet:0.12.0`, built from
sig-net/solana-signet-program, Midnight-only via `DISABLE_SOLANA`).

- Healthy startup (`docker logs -f fakenet-responder`) prints
  `MidnightMonitor: polling signet contract registry at <signet address>`.
  The responder DISCOVERS requester contracts through the signet contract,
  no caller address needed.
- `FAKENET_MANAGED=0` = you run the responder yourself (responder
  development: `yarn response` in a solana-signet-program checkout with the
  current signet address in its `.env`). The setup then leaves the container
  AND `.env` alone. When THIS repo's `@sig-net/midnight` /
  `@sig-net/midnight-contract` changes are unpublished (a decoder or event
  layout the image's npm copies do not know), this is the required mode:
  register classic-yarn links at `~/.config/yarn/link/@sig-net/{midnight →
  packages/signet-midnight, midnight-contract → packages/signet-contract}`
  pointing into this repo, run `yarn link @sig-net/midnight` and
  `yarn link @sig-net/midnight-contract` in the responder checkout, rotate
  its `fakenet-signer/midnight-level-db` aside, set its `.env`
  `MPC_ROOT_KEY` / `MIDNIGHT_WALLET_SEED` (the funded `MPC_RESPONDER_SEED`)
  / `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` from this repo's values, and start it
  AFTER the signet deploy prints the fresh address. Linking also gives
  prover/verifier parity for free: the responder proves with the same
  `src/managed` keys the deploy used. Gotcha: classic yarn's link step can
  leave EMPTY directories (e.g. `ethers/`) in the linked package's own
  `node_modules`, which break node ESM resolution with "Cannot find package
  … ethers/index.js": delete the empty dirs. Only one responder may run:
  the `/responses` helper API binds :3040.
- Prover/verifier parity: the image proves its posts with the signet zk keys
  from the published `@sig-net/midnight-contract` npm package. That is
  correct as long as the deployed signet contract came from the same
  published sources. If you changed `packages/signet-contract` and deployed
  it, every post fails verification: publish + re-release the image, or
  (local iteration) bind-mount `./packages/signet-contract/src/managed`
  over the container's key directory.
- The image tag is pinned in `docker-compose.yaml` (part of the matched
  set). On a `fakenet-v*` release, bump the tag there and
  `docker compose pull fakenet`.

## Reading failures

- **Proof server OOM (container `Exited (137)`, `OOMKilled=true`)** surfaces
  as `connect ECONNREFUSED 127.0.0.1:6300` mid-prove. Recover:
  `docker restart midnight-proof-server`, then rerun. If the submit prove
  already completed (the run printed the `CALLER_REQUEST_ID` banner), resume
  with `CALLER_REQUEST_ID=<id>` to skip the heavy submit prove. If the OOM
  killed the prove itself there is nothing to resume: rerun plain.
- **The signature-poll test times out** while setup and the submit passed:
  the responder is down or watching a stale signet address. Check with
  `docker ps -a`, `docker logs fakenet-responder`. A responder killed
  mid-post (e.g. by a proof-server restart: it proves its posts through
  the same server) does not retry, but a plain
  `docker compose --profile fakenet restart fakenet` re-discovers
  unresponded requests via its startup backfill. Restart the proof server
  only while the responder log shows no in-flight post (every
  `respond … started` line has its `took Ns`/`FAILED` twin), bearing in
  mind the idle poll loop writes every few seconds, so raw log growth never
  stops.
- `Failed Proof Server response … /check … 400` with
  `Inputs did not match alignment` in the proof-server logs: a
  circuit/runtime encoding disagreement. Known cause: a 1-variant enum in a
  `persistentHash`ed struct. Keep every enum in hashed structs at ≥ 2
  variants.
- `Wallet.InsufficientFunds` / "could not balance dust" on a young dev
  chain is transient (dust generates block by block from genesis NIGHT).
  The deploy steps already retry for ~6 minutes.
- `DustDoubleSpend` (node `Custom error: 196`): stale local wallet dust
  view. Transient: rerun, and a fresh wallet session resyncs.
