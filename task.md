# Refactor task list — midnight-erc20-vault

**How to use this file:** single source of truth for what REMAINS of the
refactor. Work one task at a time; tick the box, append the commit hash, and
record any decision you make in the Decision Log at the bottom. Run
`yarn compile && yarn build && yarn test` before calling anything
done. Read `/AGENTS.md` + the member `AGENTS.md` of any package you touch —
those rules (JSDoc on exports, latest deps, no emitted JS, simulator-only unit
tests, websocket ban, orchestration lives in the cli) are non-negotiable.

This file was rewritten 2026-07-12 after a full old-repo ↔ refactor
comparison, and updated 2026-07-15 after a second, four-track comparison
(tests / functionality / docs / hygiene — D27). The original 800-line
version (full context, Phases 0–10, Decision Log D1–D19) is in git history:
`git log --follow -- task.md`. Detailed sub-plans that outgrew this file
live next to it: `alignment.md` (struct alignment with the MPC team),
`ecdsa-midnight-progress.md` (secp256k1-in-circuit status);
`events-migration.md` was retired (A.4/D26 — discovery reverted to
registry polling). Operational knowledge moved to skills:
`.claude/skills/e2e`, `.claude/skills/contract-change`, and
`packages/xcontract-events/knowledge-base/`.

## Context in brief

Bit-by-bit rewrite of the MVP at
`~/Projects/github.com/sig-net/midnight-erc20-vault` (reference; do not
modify): an ERC20 vault on an EVM chain driven by MPC-signed transactions
requested from a Midnight Compact contract. Requests are recorded on the
vault's ledger and registered in the central signet contract's notification
registry; the MPC (response server in
`~/Projects/github.com/sig-net/solana-signet-program`,
`clients/response-server`) signs with epsilon-derived keys and posts
responses/attestations to the central signet contract; clients poll it and
settle in-circuit (Jubjub Schnorr attestation verify). No websockets.

Repo topology note (matters for archival + Phase A.3): the two checkouts
are WORKTREES of the same git repository — the old MVP is branch
`fix/withdraw-segment-safety-and-evm-harness`, this repo is
`bernard/repo-refactor`. The old repo's last unported assets do NOT live on
its checked-out branch: `signer/goldens/*.json`, `signer/README.md`,
`READING-GUIDE.md` and `.github/workflows/{integration-tests,signer}.yml`
are on `feat/signet-signer-ledger9` (read via
`git -C <old> show feat/signet-signer-ledger9:<path>`).

---

# Part 1 — What was done (verified against both repos, 2026-07-12; re-verified 2026-07-15)

All MVP functionality is ported and running end-to-end. The 2026-07-15
comparison (D27) re-verified every claim below against code: no user-facing
vault operation was lost; every old tamper/replay/wrong-key/identity/drain/
value-mismatch test assertion has a refactor twin (mostly relocated into
the simulator-only unit suites, which is better isolation); all recent
old-branch fixes (big-endian address decode, unlinkable mint nonces, single
completeWithdraw, NIGHT-UTXO registration skip) have equivalents or are
obsolete by design. Beyond the original Phase 0–10 plan, the repo also
moved to the ledger-9 toolchain line (compactc 0.33.0-rc / midnight-js
5.0.0-beta.3), generic request structs
(`SignBidirectionalRequestIndex<EVMType2TxParams<...>>`), and
registry-based request discovery (the singleton's notification registry,
polled by the MPC — D26).

- **signet-midnight** (the library, seed of a signet.js Midnight adapter):
  shared Compact modules (`Signet.compact`, `Schnorr.compact`) + compiled
  pure circuits; TS twins + tripwire tests; raw state readers (requests +
  signet contract); epsilon derivation (v1.0.0, golden-vectored against the
  MVP); MPC key derivation; Schnorr TS side; notification descriptor +
  decoder, the registry-polling request feed and resolver. 11 test files.
- **vault-contract**: all circuits ported under the new names — `initialize`,
  `deposit`, `claim` (optional recipient, incl. contract
  recipients), `withdraw`, `completeWithdraw` (settle + failure-refund
  branch folded in; the planned `refundWithdraw` name was dropped). Sealed
  `mpcPubKeyHash` + `signetNotifier`; registers SignBidirectional
  notifications on the singleton.
  Extensive simulator tests (validation, tamper, replay, identity checks).
- **signet-contract**: the central contract — unauthenticated counted
  signature-response log, in-circuit-Schnorr-verified
  `postRespondBidirectional` (first-write-wins), the notification
  registry (`notifyBidirectionalSignatureRequest`). Tested.
- **lib**: deploy plumbing, WalletFacade→midnight-js providers adapter,
  wallet/seed/network-id/node-config. One copy, consumed everywhere.
- **cli**: all 11 commands wired, zero stubs (read-state, initialize,
  deposit, poll-signature-response, poll-respond-bidirectional,
  broadcast-evm, claim, deposit-e2e, withdraw,
  complete-withdraw, withdraw-e2e).
- **integration-tests**: `happy-day-e2e.test.ts` (ordered steps: full
  deposit + withdraw round trip with golden notification assertions),
  `deposit-withdrawal-failure-refund.test.ts` (forced EVM revert → refund
  branch), `false-claimer.test.ts`, `deposit-claimant-not-caller.test.ts`,
  `benchmark.test.ts`, `mpc-keys.test.ts` — resumable via env request-ids,
  run against the local docker-compose Midnight stack + local anvil (or
  Sepolia) + the fakenet responder compose service.
- **response server** (cross-repo, solana-signet-program
  `bernard/add-response-contract`): MidnightMonitor rewritten for the new
  layout, registry-polling request discovery, responses written to the
  signet contract, ledger-9 bump. Consumes the published
  `@sig-net/midnight*` npm packages (D.1 done).
- **Polling end to end — one registry, no per-requester scanning.**
  Requests are discovered by polling the singleton's notification registry
  (signet-request-feed); each notification is authenticated by reading the
  request back from the named caller's own ledger. Responses are polled
  from the singleton's response indexes by request id
  (signet-request-response-reader, consumed by the cli poll commands and
  the response server alike). Websockets remain banned; indexer state lag
  must be tolerated (poll loops, never one-shot reads).
- **Docs/ops**: `docs/architecture.md`, `docs/e2e-sepolia-runbook.md`,
  root docker-compose stack, /e2e and /contract-change skills,
  xcontract-events spike + knowledge base.
- **Beyond the MVP** (for the record — the "or better" credit): central
  signet contract with an on-chain response log (the MVP had none);
  hardened withdraw (contract-fixed gas envelope, `keyVersion >= 1`,
  sealed chain id/caip2/notifier); optional claim recipient; versioned
  fail-closed notification envelope; distinct requestId-bound
  `withdrawRefundCommitment` domain (refunds unlinkable to the deposit
  identity); large new test surface (raw-state reader parity,
  forged-notification rejection, golden crypto vectors, config
  validation, benchmark).

---

# Part 2 — Remaining migration phases

Ordered by dependency. Each task has a *Done when*. Protocol
alignment/freeze is deliberately LAST (Phase E, Finalisation) — until it
lands every deployment is throwaway (struct changes change all request
ids); that is an accepted cost while the protocol is still moving.

## Phase A — Wire-format versioning

This repo is becoming the source of truth for the final protocol wire
types (the old repo's SGN1 spec + `signer/` prototype are inputs, not the
destination). Discovery is registry-polling (see Part 1, D26) — what
is missing is versioning, so that future encoding changes (compiler/runtime
value-encoding shifts, struct evolution) can coexist with deployed
consumers instead of breaking them.

- [ ] **A.1 Version the notification wire format.** Partially landed with
      D26: `SignBidirectionalNotification` is a `{ version, payload }`
      envelope, the payload manually packed, and the decoder
      (signet-contract-state-reader.ts) fails closed on unknown versions.
      Remaining: the coexistence rule ("layout change ⇒ new version, old
      version keeps decoding") once a V2 exists.
- [ ] **A.2 Version the request-id preimage and domain tags.** Domain
      strings carry a version; a struct/layout change mints a new version
      while old ids stay resolvable.
- [ ] **A.3 Golden vectors per wire version.** Port the old repo's
      `signer/goldens` approach: vectors regenerated from the compiled
      contracts, pinnable by the MPC/Rust consumer. Source material is on
      the old repo's `feat/signet-signer-ledger9` branch
      (`signer/goldens/*.json` + `signer/README.md`), NOT its checked-out
      branch — see the topology note in Context.
      *Done when (A.1–A.3):* a simulated "v2" encoding change lands
      alongside v1 with both decodable in tests.
- [x] **A.4 Absorb/retire `events-migration.md`.** DONE with D26.

## Phase B — Hermetic test loop + CI

In the old repo the self-contained loop WAS the CI pipeline:
`integration-tests.yml` ran `vault.api.test.ts` (in-process MPC
simulator + watcher + Hardhat TestUSDC harness + standalone stack) on
every PR — hermetic, no external funds. B.1 + B.2 rebuilt that loop here
on the real artifacts (local anvil + dockerized fakenet). What remains is
the CI itself — confirmed 2026-07-15 as the single biggest regression
vs the old repo: there is no `.github/` directory at all, so nothing
gates a PR.

- [x] **B.1 Port the EVM harness** — DONE (D23, commit a98256b): hardhat 3 +
      TestUSDC live in `packages/integration-tests`; the node is the
      external long-running `evm` compose service (anvil, chain id 31337);
      setup resolves the chain id from `EVM_RPC_URL`, deploys the token
      when the address has no code, and auto-funds both derived accounts.
- [x] **B.2 Dockerize the real fakenet responder** — DONE (2026-07-15,
      D24): `ghcr.io/sig-net/fakenet` (multi-arch, published on
      `fakenet-v*` tags) runs as the profile-gated `fakenet` compose
      service after run 1 writes `MPC_ROOT_KEY` +
      `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` to `.env`. Upstream
      `DISABLE_SOLANA` skips the Solana leg; the published
      `@sig-net/midnight-contract` tarball ships the signet prover keys.
- [ ] **B.3 GitHub Actions — one test stream, setup-managed hand-off**
      (design per D28; workflow + setup automation landed, awaiting first
      green run). CI runs the SAME commands a developer types — no ported
      old workflow, no CI-only harness. What landed:
      1. Setup automation (packages/integration-tests): after the signet
         deploy, two new pipeline steps persist `MPC_ROOT_KEY` +
         `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` to `.env` (STRICTLY append-only
         via `appendRepoDotEnv`; conflict with a shell override = hard
         error) and start the `fakenet` compose service (`--force-recreate`
         only when values newly landed in `.env`). `FAKENET_MANAGED=0`
         opts out (responder development). A fresh LOCAL deployment is now
         ONE run — the run-1/run-2 hand-off survives only on Sepolia
         (manual funding).
      2. `.github/workflows/ci.yml`: `unit` job (compile skip-zk → build →
         unit tests; restores the zk cache read-only because
         signet-contract's build demands prover keys), `integration` job
         (compose stack up → happy-day on PRs, full suite nightly/manual;
         larger runner label `ubuntu-latest-8-cores`), `zk-canary` job
         (weekly/manual fresh keygen, row counts in the log). Caches:
         compact toolchain (weekly key) + zk proving keys (keyed on
         compiler version + all `.compact` sources; the setup honors a hit
         via `TRUST_PREBUILT_ZK_KEYS=1`, CI-only).
      Remaining before ticking:
      - [x] Make `ghcr.io/sig-net/fakenet` PUBLIC — done 2026-07-15
            (anonymous manifest pull verified).
      - [x] Compiler blocker RESOLVED (2026-07-16): compactc 0.33.0-rc.0
            has public Linux builds on the toolchain's LF home,
            **LFDT-Minokawa/compact** GitHub releases (the launcher's
            channel lists stable only, hence the earlier "not released"
            dead end). CI downloads the
            `x86_64-unknown-linux-musl` zip directly and the launcher
            adopts it (`compact update <ver>` uses an on-disk version
            without downloading).
      - [x] **First green run 2026-07-16 (PR #16, run 29482481765):**
            unit 1m42s (zk cache hit), integration 11m40s — full
            happy-day round trip on a fresh chain: rc toolchain install,
            skip-zk compile, cached keygen, compose stack, dust-retry
            deploys, .env hand-off append, fakenet auto-start, all
            proving legs. The default `ubuntu-latest` (4-core/16 GB)
            handled the proofs — the larger-runner switch (TODO in
            ci.yml) is now an optimization, not a requirement; revisit if
            the nightly full suite OOMs.
      Fixed en route (all on PR #16): setup-node package-manager cache
      probe vs yarn 4; xcontract-events `Token` managed-dir casing
      (macOS-only lowercase); deploy retry on `Wallet.InsufficientFunds`
      (dust generates block by block on a young chain).
      *Done when:* a PR shows green checks from a fresh clone — achieved
      on PR #16; tick when it merges into the refactor branch.
      *Done when:* a PR shows green checks from a fresh clone.

## Phase C — Remaining flow tests

Test-coverage verdict from the 2026-07-15 comparison: same-or-better at
the assertion level (every old scenario mapped to a twin), EXCEPT the two
items below, which are the only old-repo behaviors with no refactor twin.

- [x] **C.1 `false-claimer.test.ts`** — DONE (2026-07-12): identity B's
      claim rejects in-circuit ("path hex does not match commitment"), the
      request stays on the ledger, identity A claims it, the drain cycles
      the EVM funds; 6/6 green. `runDepositRoundTrip` gained a `skipClaim`
      option for the arrange stage.
- [x] **C.2 `benchmark.test.ts`** — DONE (2026-07-13): deposit + withdraw
      round trips driven long-hand, one timed leg per test with an explicit
      stopwatch bracketing exactly the cli command measured; reports
      per-leg wall clock (banner table + a greppable
      `BENCHMARK_TIMINGS_JSON` line); 13/13 green.
- [ ] **C.3 Bearer-transfer ownership handoff test.** Old
      `vault.e2e.test.ts` STEP 8 proved value moves with the shielded
      coin: transfer vault tokens A→B, then assert A (balance 0) can no
      longer withdraw and B can. The refactor covers the adjacent pieces
      (permissionless success-settle in the simulator suite; mint directed
      to another wallet in `deposit-claimant-not-caller.test.ts`) but not
      the transfer-then-withdraw handoff itself. Cheapest home is probably
      the simulator suite (mint to A, move the coin to B's identity,
      withdraw as B / reject as A); a live variant can ride an existing
      integration flow if the simulator can't express the transfer.
      *Done when:* a test proves old-owner-loses / new-owner-gains.
- [ ] **C.4 Infra smoke checks (low; pull forward if flows keep failing
      mid-run).** The old repo's `evm-harness.verify.test.ts` +
      `fund-wallet.test.ts` gave fast confidence the test infra itself
      worked before the slow proven flows; the fakenet replacement has no
      equivalent, so a broken stack surfaces only mid-flow. Candidate: a
      cheap first integration test (or globalSetup assertion) that checks
      compose services, ERC20 code on chain, derived-account balances, and
      fakenet liveness. A live over-balance-withdraw rejection assert
      (old #10 — wallet-level, not in-circuit, so no simulator twin) can
      ride the same suite.
      *Done when:* a wrecked stack fails in seconds with a named cause,
      not minutes into a proven flow.

Recorded as NOT tasks (so they aren't re-found by the next comparison):
the old `deserialize.test.ts` / `test-deserialize.compact` multi-type
Solidity deserialization golden vectors were superseded, not lost — the
contract now reads only a bool-success word (output schema
`[{"name":"success","type":"bool"}]`); revisit only if the output schema
ever widens (hook: the Phase E.1 field-sizing pass). The old
`counter.api.test.ts` was boilerplate, correctly dropped.

## Phase D — Loose ends

- [x] **D.1 Publish the common lib** — DONE (verified 2026-07-15): the
      responder consumes the published `@sig-net/midnight@0.0.3` +
      `@sig-net/midnight-contract@0.0.3` npm packages (no cross-repo
      `link:` deps), which is what unblocked B.2.
- [ ] **D.2 Deployment manifest — keep or drop** (old 2.3/4.5): env-var
      resume (`DEPOSIT_REQUEST_ID` etc.) replaced it in practice. Either
      implement `deployments/<network>.json` + an ensure-deployed helper, or
      log the decision that env-vars are the mechanism and delete the idea.
- [ ] **D.3 Hardening backlog** (pull forward as needed): caip2Id↔chainId
      consistency enforcement point; TS branding for request ids; JSDoc
      sweep of early-ported code (2026-07-15 spot-check found only three
      misses: `ParseError` in `packages/lib/src/seed.ts`, `NETWORK_IDS` in
      `packages/lib/src/network-id.ts`, and the `SeedFormat` type
      companion in seed.ts — compliance is otherwise high).
- [ ] **D.4 Repo hygiene + docs finish.** Expanded 2026-07-15 with the
      comparison's concrete findings (hygiene verdict otherwise: committed
      tree is clean — no level-db dirs, no dist/, no emitted JS, no
      .DS_Store were EVER committed; the old "un-commit stray dirs" worry
      is moot, they are working-tree-only and gitignored). Sub-items:
      - Delete `scripts/placeholder.sh` (only file in `scripts/`; its
        stated purpose — hold the dir until integration-tests arrive — is
        obsolete) and the stale untracked root `scratch.md` (its content
        is B.2, now done). `changed-notes.md` is already gone.
      - **README front door** (the least-finished doc in the repo): finish
        the truncated `### Criteria` section (body is literally "To run
        the "); fix `compact update 0.31.1` (wrong AND pinned — toolchain
        is compactc 0.33.0-rc/ledger-9 and AGENTS.md says unpinned);
        refresh the package tree (shows 4 of 8 packages, and
        `scripts/placeholder.sh` as the only script); fold the README
        "TODOs" block into this file; remove the temporary porting banner
        (and its CLAUDE.md twin) at merge to main.
      - **docs/architecture.md**: fill the three `TODO(port)` stubs
        (withdraw/completeWithdraw flow + lane diagram —
        `packages/cli/README.md` already documents the flow, port it);
        fix the `postResponse()` naming drift (repo-wide name is
        `postSignatureResponse`).
      - **docs/e2e-sepolia-runbook.md** is a decoy: kept deliberately
        (D25) but internally half-migrated (`EVM_RPC_URL` renamed at two
        lines, everything around it old, including the purged
        `MPC_WS_URL` websocket path and `boilerplate/contract-cli` paths).
        Add a "SUPERSEDED — see packages/integration-tests/README.md +
        /e2e skill" banner, or delete it.
      - Fix stale "`npm run compact`" / "`npm run compile`" comments in
        the five per-package `.gitignore` files (signet-contract,
        signet-midnight, vault-contract, xcontract-events,
        integration-tests) — one names a nonexistent `compact` script.
        These are NOT part of D25's deliberately-kept npm mentions.
      - **AGENTS.md emit-rule carve-out**: the absolute "no `dist/`, no
        `tsc --outDir`" rule contradicts the two packages that
        legitimately publish emitted JS (`signet-midnight`,
        `signet-contract` via `tsconfig.build.json` + `files:["dist"]`).
        Document the publish exception in the rule.
      - **Decide the `packages/xcontract-events` fate**: the
        `knowledge-base/` is the value (D26 keeps it); the surrounding
        self-described "throwaway spike" code (token/vault compacts,
        deploy scripts, tests) reads as clutter. Demote to
        knowledge-base-only, or fence it explicitly as a spike fixture.
      - Trivial consistency: drop `--passWithNoTests` from
        signet-midnight's test script (it has 11 test files).
      - **Onboarding doc decision**: the old repo's `READING-GUIDE.md`
        (on `feat/signet-signer-ledger9`) — the read-in-this-order /
        what-to-skip / background-links curriculum — has no successor and
        is the biggest pure docs loss. Either write this repo's own
        reading guide or log the decision that it dies with the old repo.
      - Mark the old repo superseded and plan its archival once its last
        unported assets have moved (signer goldens + CI workflow +
        READING-GUIDE — all on `feat/signet-signer-ledger9`; remember the
        two checkouts are worktrees of one repository).
- [x] **D.5 Migrate the workspace from npm to Yarn** — DONE (D25, commit
      aed77b2; verified 2026-07-12: fresh install, 225 unit tests green,
      cross-repo symlinks resolve).
- [ ] **D.6 Verify withdraw segment safety (correctness — do first).**
      The only correctness-flavored divergence the 2026-07-15 comparison
      found. The old repo's `withdraw` used an explicit
      `kernel.checkpoint()` (commit c39ff9c; the old worktree's branch is
      named for it) to split the guaranteed segment (validate +
      `receiveShielded`) from fallible writes, so a failure after taking
      the coin cannot strand it. The refactor's `withdraw` validates and
      checks `member` BEFORE `receiveShielded` (good) but has no
      checkpoint, and the post-coin-take segment now contains a fallible
      CROSS-CONTRACT call (`notifyBidirectionalSignatureRequest` on the
      singleton) plus the nonce/index/refundCommitment writes. Under
      Compact's revert-all-on-fallible-failure semantics a failed notify
      probably reverts the whole tx (coin returned, not stranded) — but
      that is an assumption, not a verified property.
      *Done when:* the transaction-segment semantics of the current layout
      are confirmed (docs/experiment: force the notify to fail, observe
      the coin) OR a checkpoint is deliberately placed, and the outcome is
      recorded as a Decision Log entry either way.
- [ ] **D.7 Dev-convenience commands — decide/port (low).** The old
      repo's standalone utilities have no wrappers here: `generate-key.js`
      (one-shot wallet seed + address → .env), `check-balance.js` (wallet
      NIGHT/dust balance), `request-faucet.js` (testnet faucet transfer).
      The primitives all exist in `packages/lib` (seed.ts, wallet.ts);
      only wrapping is missing. Matters only if Preview/testnet onboarding
      is a target (the local loop auto-funds). Either add thin cli
      commands or log the decision that the local flow + runbook cover it.

## Phase E — Finalisation: protocol alignment & freeze

Joint work with the MPC/signer colleague; done at the END by choice —
everything above can proceed on the current shapes, at the cost of
redeploys when this lands.

- [ ] **E.1 Align request/response structs with the MPC-canonical shapes.**
      Work the `alignment.md` checklist: request-id scheme (whole-struct
      `persistentHash` vs their tails-hash), `SignetMPCRoutingParams`
      (`path` → `commitment: Bytes<32>`?), `EVMCalldata` field order,
      response struct names, commitment domain string. Old task 1.4 (field
      right-sizing: path 256→64 etc., est. ~419K → ~150–250K deposit rows)
      folds into this — decide widths in the same pass. The 2026-07-15
      comparison adds two intentional divergences from the MVP to confirm
      in the same sign-off: the attestation-message preimage changed
      (`hash(outputData: Bytes<4096>)` → `hash(hash(output: Bytes<128>),
      outputLen)`) and the Schnorr challenge reduction changed (248-bit
      witness division → `as JubjubScalar` cast) — both must match the MPC
      signer exactly.
      *Done when:* shapes signed off by the MPC team, recorded in the
      Decision Log, structs + TS twins + readers updated in one change,
      new row counts measured and logged.
- [ ] **E.2 Decide the attestation crypto for `respond_bidirectional`.**
      The SGN1 spec assumes secp256k1 ECDSA (off-chain verified);
      `claim` needs in-circuit verification, which today means Jubjub
      Schnorr (`ecdsa-midnight-progress.md`: secp256k1 in-circuit is
      unscheduled). Outcome needed: MPC produces the Jubjub attestation, or
      the claim flow changes.
      *Done when:* decision logged; both sides implement it.
- [ ] **E.3 Freeze + publish the versioned wire spec** (successor of the
      old repo's `signet-midnight-events.md`), co-signed by both sides,
      with golden vectors regenerable by this repo's harness and the MPC's
      Rust consumer. First long-lived deployment happens after this.
      Note for this pass: the repo is local-only by design (no
      proof-server devnet/testnet compose variants like the old repo's) —
      the first long-lived deployment is the hook to document non-local
      network bring-up.

---

# Part 3 — Decision Log

Append-only. Full log D1–D19 (single-map index, whole-struct request ids,
COMPACT_PATH imports, contract-polled responses, epsilon v1.0.0 port,
midnight-js callTx, env-accumulator suite, SignetNonce, …) is in git history
of this file. Never reference task.md from anywhere outside this file.

### D20 — task.md rewritten as remaining-work list (2026-07-12)
**Decision:** Replaced the Phase 0–10 plan with the done-summary + Phases
A–F above after a two-repo comparison showed all MVP flows ported and
running e2e. Sub-plans live in events-migration.md / alignment.md.
**Impact:** none on code; historical context via `git log --follow -- task.md`.

### D21 — `refundWithdraw` name dropped (retroactive record, 2026-07-12)
**Decision:** The refund path is the failure branch inside
`completeWithdraw` (one settle circuit branching on the MPC's EVM result),
not a separate `refundWithdraw` circuit as D13 planned.
**Why:** success-finalize and failure-refund are one settlement decision on
the same attestation; two circuits would duplicate the verify chain.

### D22 — Phase reordering: freeze last, versioning first (2026-07-12)
**Decision:** Per Bernard: protocol alignment & freeze is finalisation work
(now Phase E, last) — throwaway deployments until then are an accepted
cost. The events migration phase was replaced by wire-format VERSIONING
(Phase A): the stack is already event-driven end to end with no blind
ledger polling (events trigger authenticated state reads; the only
interval loop is transport-level polling of the indexer's event endpoint),
and this repo — not the old repo's SGN1 prototype — is the source of truth
for the final wire types. The hermetic local loop (old-repo
`vault.api.test.ts` + MPC simulator/watcher + Hardhat harness) was the old
repo's actual CI pipeline, not a convenience, so it merges with CI as
Phase B.

### D23 — Local EVM is test setup, not a package; on-chain code is the ERC20 skip signal (2026-07-12)
**Decision:** Phase B.1 split off from B.2 (MPC simulator port, still open)
and implemented as pure integration-test setup: hardhat + `TestUSDC.sol`
are devDependencies/files of `packages/integration-tests` — no new workspace
member, no harness package, no in-test node spawning. The hardhat node is
external and long-running (the `evm` compose service, part of
`docker compose up -d`), so it survives the run-1 → start-responder → run-2
hand-off. New setup steps: `resolveEvmChain` (chain id resolved from
`EVM_RPC_URL`, verified loudly when preset — it is sealed into the vault at
initialize; Sepolia-USDC defaulting is now chain-aware), `ensureErc20Deployed`
(skip signal is the ON-CHAIN `getCode` check, not env presence — a kept
`ERC20_ADDRESS` can outlive a wiped local chain; deploys TestUSDC only on
chain id 31337, throws elsewhere), `fundLocalEvmAccounts` (idempotent top-up
of both derived accounts to 10 ETH / 1000 USDC, local chain only).
**Why:** switching the whole suite to a local EVM must cost exactly one env
change (`EVM_RPC_URL`); the old repo's always-fresh-spawn harness cannot skip,
and env-presence skipping cannot detect a wiped chain.
**Impact:** unlike the old repo the MPC root key is NOT throwaway-per-run
locally — the fakenet responder still holds it (B.2 replaces this with the
in-process simulator). Deterministic nonce-0 deploy keeps `ERC20_ADDRESS`
stable across local chain wipes.

### D24 — No simulator port; dockerize the real fakenet, after the common lib ships (2026-07-12)
**Decision:** Per Bernard: B.2 will NOT port the old repo's in-process MPC
simulator/watcher ("double fakenet" — the fakenet responder IS already the
simulator). Instead the actual solana-signet-program response server gets
dockerized into the compose stack. That work is PAUSED until the common lib
(signet-midnight / signet-contract / lib) is published — D.1, upgraded from
"decide the dependency form" to the prerequisite — because the responder's
cross-repo `link:` deps would otherwise be baked into the image.
**Why:** a ported simulator is a third implementation of the MPC logic that
drifts, and CI would exercise the copy instead of the real artifact. The
trade-off (heavier, slower CI: on-chain proving, image build, zk-key cache,
a pinned cross-repo ref) is accepted.
**Impact:** feasibility findings recorded in B.2 (upstream gaps: no
`EVM_RPC_URL` override, unconditional Solana boot leg, gitignored ~85 MB zk
prover material). B.1's local EVM cannot complete a round trip until the
responder can target a local RPC; B.3's integration job waits on B.2, its
compile/unit rows can land independently.

### D25 — npm → Yarn 4 migration choices (2026-07-12)
**Decision:** The workspace package manager is Yarn 4 (corepack
`packageManager` field; no committed release blob), with `nodeLinker:
node-modules` and `enableScripts: true` forced in `.yarnrc.yml`. `yarn.lock`
is gitignored exactly like package-lock.json was — the latest-stable-never-pin
rule keeps working through fresh installs. Root aggregate scripts use
`yarn workspaces foreach --all --exclude midnight-erc20-vault --topological`
(the root workspace must be excluded or foreach recurses into the aggregate
script itself and runs every member twice). `tsx` was added as a root
devDependency because `yarn run` only exposes declared deps' binaries (npx
fell back to `.bin` regardless — `yarn tsx` does not). AGENTS.md's install
rule now spells the caret explicitly (`yarn workspace <ws> add <pkg>@^<ver>`)
because unlike npm, `yarn add` writes exactly the range named — a bare
version would silently pin. The `npm audit signatures` provenance check was
dropped from the install rule (no yarn equivalent; `yarn npm audit` covers
advisories).
**Why:** node-modules linker (not PnP) because the @midnight-ntwrk wasm
packages, `COMPACT_PATH=../../node_modules` compile imports, and the response
server's cross-repo symlinks all require a real hoisted tree.
**Impact:** none on wire formats or deployments. npm-registry references in
docker-compose.yaml comments and the old-repo commands in
`docs/e2e-sepolia-runbook.md` intentionally still say "npm". Verified: fresh
install, compile/build/test green (225 tests), solana-signet-program symlinks
into this tree still resolve.

### D26 — Events purged; discovery via a singleton notification registry (2026-07-14)
**Decision:** Per Bernard: contract event emission is removed ENTIRELY (the
`serialize<T,256>` emit path proved too slow — heavy serialization into a
forced-large payload). The singleton gained ledger field 4,
`Map<RequestId, SignBidirectionalNotification>`; clients cross-contract-call
`notifyBidirectionalSignatureRequest(requestId, notification)` (rename of the
emit circuit) and the MPC discovers requests by polling that registry,
still authenticating each notification against the named caller's own
ledger. `SignBidirectionalNotification` is `{ version: Uint<8>, payload:
Bytes<65> }`, the payload manually packed in-circuit via `Bytes[...spread]`
(callerAddress ++ requestId ++ requestsIndexField — exact, no padding, no
`serialize<>` anywhere). The registry is keyed by requestId, append-only
(idempotent overwrite, no removal); the feed's in-memory yielded set is the
diff cursor. The response-side ping events were deleted with no replacement
store — clients poll the response indexes by request id through
`SignetRequestResponseReader` (the cli poll commands switched to it).
External surface renamed `SignetEventEmitter` → `SignetNotifier`;
`signet-events.ts`, `signet-event-observer.ts`, `signet-response-feed.ts`
deleted; `events-migration.md` deleted (A.4). `packages/xcontract-events`
is kept as the cross-contract-call knowledge base.
**Why:** event emission cost dominated request-circuit latency; the ledger
write is cheaper, and a registry read via `queryContractState` needs no
special MIP-0002 indexer build.
**Impact:** singleton + vault proving keys changed ⇒ full redeploy;
`@sig-net/midnight` / `@sig-net/midnight-contract` republished as 0.0.2 and
the fakenet responder's pins bumped (its `SignetRequestFeed` interface is
unchanged — only construction lost `fromEventId`).

### D27 — Second full comparison folded in; four new tasks (2026-07-15)
**Decision:** A four-track old↔new comparison (test coverage,
functionality, docs, hygiene) re-verified Part 1 and rewrote Part 2 to
carry only what remains. Verdicts: test coverage same-or-better at the
assertion level; no user-facing functionality lost (intentional
simplifications — dynamic CLI, bespoke RLP, flat ledger maps,
testcontainers — all confirmed correct); operational docs better than the
MVP's; committed tree clean. New tasks minted from the gaps: **C.3**
(bearer-transfer handoff test, old STEP 8's only untwinned assertion),
**C.4** (infra smoke checks, low), **D.6** (verify withdraw segment
safety — no `kernel.checkpoint()` and a fallible cross-contract notify
after the coin take; the only correctness-flavored finding), **D.7**
(dev-convenience command wrappers, low). D.4 was expanded from a
one-liner to the concrete finding list (README front door incl. the wrong
`compact update 0.31.1`, architecture.md TODO stubs, runbook SUPERSEDED
banner, `.gitignore` npm comments, AGENTS.md emit carve-out,
xcontract-events fate, READING-GUIDE successor). B.3 remains the single
biggest regression (no `.github/` at all). Also recorded: the two
checkouts are worktrees of one git repository, and the unported assets
(signer goldens, CI workflows, READING-GUIDE) live on
`feat/signet-signer-ledger9`.
**Impact:** none on code; this file is the only artifact. Superseded
worries closed: level-db dirs / .DS_Store were never committed (D.4's
un-commit sub-item removed); `changed-notes.md` already gone; the
deserialization golden vectors are recorded as superseded-not-lost under
Phase C.

### D28 — CI is the developer commands; the setup finishes its own fakenet hand-off (2026-07-15)
**Decision:** Per Bernard: CI does NOT port the old repo's workflow — two
test streams are impossible to reconcile, so the ONE integration suite
(packages/integration-tests) runs everywhere with the identical commands.
To make that possible the setup pipeline completes the fakenet hand-off
itself: right after the signet deploy it appends `MPC_ROOT_KEY` +
`MIDNIGHT_SIGNET_CONTRACT_ADDRESS` to the repo-root `.env` and starts the
`fakenet` compose service. The `.env` write is APPEND-ONLY by construction
(`appendRepoDotEnv` — `fs.appendFileSync` under a provenance comment; a
library that rewrites the file was considered and rejected: dotenvx's
`set()` encrypts by default and re-serializes, and an append can never
corrupt an operator's hand-edited file). A hand-off key already in `.env`
with a different value is a hard error (docker compose reads the file — a
silent divergence would start the responder against stale values), and
`--force-recreate` applies exactly when values newly landed in `.env`.
`FAKENET_MANAGED=0` opts out of both steps (responder development).
Both automated actions are ordinary named pipeline steps — same headers,
same STEP_THROUGH pauses, exact file lines and docker command logged; no
hidden magic. CI specifics: PR gate runs happy-day only, the full suite
runs nightly (same tests, a selection difference, not a second stream);
zk proving keys are cached keyed on compiler version + all `.compact`
sources, honored by the setup only under CI's explicit
`TRUST_PREBUILT_ZK_KEYS=1` (locally, key presence ≠ freshness); the
compact toolchain is cached on a weekly key (still unpinned); larger
runner for the integration job (proof peaks ~8–10 GiB).
**Impact:** a fresh LOCAL deployment is one run end-to-end (the two-run
hand-off survives only on Sepolia, for manual funding); the e2e skill and
integration-tests README were rewritten accordingly. Discovered en route:
signet-contract's `build` fails without prover keys (publish-safety check),
so a truly fresh clone needs one zk keygen before `yarn build` — the unit
CI job restores the zk cache read-only and keygens signet-contract on a
miss. Publishing `ghcr.io/sig-net/fakenet` publicly is the remaining B.3
prerequisite, deliberately sequenced AFTER this automation landed.

<!-- Append new decisions below this line. -->
