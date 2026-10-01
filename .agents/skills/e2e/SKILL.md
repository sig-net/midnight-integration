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
(`ghcr.io/sig-net/fakenet:0.18.0`, built from
sig-net/solana-signet-program, Midnight-only via `DISABLE_SOLANA`).

- Healthy startup (`docker logs -f fakenet-responder`) prints
  `MidnightMonitor: polling signet contract registry at <signet address>`.
  The responder DISCOVERS requester contracts through the signet contract,
  no caller address needed.
- `FAKENET_MANAGED=0` = you run the responder yourself (responder
  development: `yarn response` in a solana-signet-program checkout with the
  current signet address in its `.env`). The setup then leaves the container
  AND `.env` alone. That checkout consumes the published `@sig-net/midnight`
  / `@sig-net/midnight-contract` from npm — the same releases the pinned
  image bundles — so by default no linking of any kind is involved. Rotate
  the responder's `fakenet-signer/midnight-level-db` aside, set its `.env`
  `MPC_ROOT_KEY` / `MIDNIGHT_WALLET_SEED` (the funded `MPC_RESPONDER_SEED`)
  / `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` from this repo's values, and start it
  AFTER the signet deploy prints the fresh address. Only one responder may
  run: the `/responses` helper API binds :3040.
- **Local library linking is opt-in ONLY.** Run the tarball flow below ONLY
  when the user explicitly asks for it ("yarn link", "local library
  linking", "link the local packages into the responder", or equivalent).
  Never adopt it on your own initiative, even when this repo carries
  `@sig-net/midnight` / `@sig-net/midnight-contract` changes the published
  packages lack (a decoder, event layout or hash): the default way to land
  such a change is to release the packages, re-release the image on them,
  and bump the pin (see prover/verifier parity below). When linking IS
  requested, link as PACKED TARBALLS, which is what makes yarn apply each
  package's `publishConfig` (the dev `exports` point at raw `src/*.ts`, the
  published ones at `dist`):

  ```sh
  # here, after any .compact or SDK edit
  yarn compile:signet-contract:zk   # REQUIRED once: the contract build
                                    # hard-fails without src/managed/keys
  yarn workspace @sig-net/midnight pack
  yarn workspace @sig-net/midnight-contract pack
  ```

  then in `fakenet-signer/package.json` point both deps at the tarballs
  (`"file:../../<this-repo>/packages/signet-{midnight,contract}/package.tgz"`)
  and `yarn install`. Verify with
  `node -e "console.log(require.resolve('@sig-net/midnight-contract/managed/compiler/contract-manifest.json'))"`:
  it must land under `dist/managed`, with `dist/managed/keys` beside it.
  Prefer this over `yarn link` on the raw directories even when the user
  says "yarn link": a symlinked package resolves its own
  `@midnight-ntwrk`/wasm deps from THIS repo's `node_modules`, giving two
  onchain-runtime instances across the boundary. Refresh cycle after each
  edit (classic yarn caches `file:` tarballs by name@version and pins their
  checksum):
  `yarn cache clean @sig-net/midnight @sig-net/midnight-contract && rm -rf node_modules/@sig-net && yarn install --update-checksums --check-files`.
  The tarball also gives prover/verifier parity for free: the responder
  proves with the same keys the deploy used.
- Prover/verifier parity: the image carries the signet zk keys from the
  published `@sig-net/midnight-contract` npm package, and it joins the
  deployed contract through midnight-js `findDeployedContract`, which
  compares the verifier key of EVERY operation, not only the `respond` it
  calls. Any edit that changes a circuit changes that circuit's verifier key,
  so touching `signBidirectional` alone locks the responder out. The join
  throws `ContractTypeError: Following operations: … are undefined or have
  mismatched verifier keys`, no post ever happens, and the poll test times
  out with nothing in the test output to explain it. `packages/signet-contract`
  must therefore compile to the same artifacts as the published release the
  pinned image bundles. Check that without a zk build:
  `npm pack @sig-net/midnight-contract@<version>`, then diff its
  `dist/managed/zkir/*.zkir` against `src/managed/zkir/*.zkir` from a plain
  `yarn compile:signet-contract`. Keygen is deterministic, so identical zkir
  means identical keys. To land a real contract change: release the packages,
  rebuild and re-release the image on them, then bump the pin here. Only when
  the user has explicitly opted into local linking (see the opt-in bullet
  above), bind-mount `./packages/signet-contract/src/managed` over the
  container's key directory instead.
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
  the responder is down, watching a stale signet address, or refusing to join
  the contract on a verifier-key mismatch (see prover/verifier parity above).
  The test output distinguishes none of these. Check with `docker ps -a`,
  `docker logs fakenet-responder`. A responder killed
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
  hashed struct. Keep every enum in hashed structs at ≥ 2 variants.
- `Wallet.InsufficientFunds` / "could not balance dust" on a young dev
  chain is transient (dust generates block by block from genesis NIGHT).
  The deploy plumbing retries the balancing step for ~6 minutes before
  surfacing it.
- `DustDoubleSpend` (node `Custom error: 196`): stale local wallet dust
  view. Transient: rerun, and a fresh wallet session resyncs.
