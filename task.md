# Refactor task list — midnight-erc20-vault

**How to use this file:** single source of truth for what REMAINS of the
refactor. Work one task at a time; tick the box, append the commit hash, and
record any decision you make in the Decision Log at the bottom. Run
`yarn compile && yarn build && yarn test` before calling anything
done. Read `/AGENTS.md` + the member `AGENTS.md` of any package you touch —
those rules (JSDoc on exports, latest deps, no emitted JS, simulator-only unit
tests, websocket ban, orchestration lives in the cli) are non-negotiable.

This file was rewritten 2026-07-12 after a full old-repo ↔ refactor
comparison. The original 800-line version (full context, Phases 0–10,
Decision Log D1–D19) is in git history: `git log --follow -- task.md`.
Detailed sub-plans that outgrew this file live next to it:
`events-migration.md` (polling → MIP-0002 events), `alignment.md`
(struct alignment with the MPC team), `ecdsa-midnight-progress.md`
(secp256k1-in-circuit status). Operational knowledge moved to skills:
`.claude/skills/e2e`, `.claude/skills/contract-change`, and
`packages/xcontract-events/knowledge-base/`.

## Context in brief

Bit-by-bit rewrite of the MVP at
`~/Projects/github.com/sig-net/midnight-erc20-vault` (reference; do not
modify): an ERC20 vault on an EVM chain driven by MPC-signed transactions
requested from a Midnight Compact contract. Requests are recorded on the
vault's ledger and emitted as events; the MPC (response server in
`~/Projects/github.com/sig-net/solana-signet-program`,
`clients/response-server`) signs with epsilon-derived keys and posts
responses/attestations to the central signet contract; clients poll it and
settle in-circuit (Jubjub Schnorr attestation verify). No websockets.

---

# Part 1 — What was done (verified against both repos, 2026-07-12)

All MVP functionality is ported and running end-to-end. Beyond the original
Phase 0–10 plan, the repo also moved to the ledger-9 toolchain line
(compactc 0.33.0-rc / midnight-js 5.0.0-beta.3), generic request structs
(`SignBidirectionalRequestIndex<EVMType2TxParams<...>>`), and MIP-0002
contract events.

- **signet-midnight** (the library, seed of a signet.js Midnight adapter):
  shared Compact modules (`Signet.compact`, `Schnorr.compact`) + compiled
  pure circuits; TS twins + tripwire tests; raw state readers (requests +
  signet contract); epsilon derivation (v1.0.0, golden-vectored against the
  MVP); MPC key derivation; Schnorr TS side; event codecs, observer,
  request/response feeds and resolver. 14 test files.
- **vault-contract**: all circuits ported under the new names — `initialize`,
  `requestDeposit`, `claimDeposit` (optional recipient, incl. contract
  recipients), `requestWithdraw`, `completeWithdraw` (settle + failure-refund
  branch folded in; the planned `refundWithdraw` name was dropped). Sealed
  `mpcPubKeyHash` + `signetEventEmitter`; emits SignBidirectional events.
  Extensive simulator tests (validation, tamper, replay, identity checks).
- **signet-contract**: the central contract — unauthenticated counted
  signature-response log, in-circuit-Schnorr-verified
  `postRespondBidirectional` (first-write-wins), event emission. Tested.
- **lib**: deploy plumbing, WalletFacade→midnight-js providers adapter,
  wallet/seed/network-id/node-config. One copy, consumed everywhere.
- **cli**: all 11 commands wired, zero stubs (read-state, initialize,
  request-deposit, poll-signature-response, poll-respond-bidirectional,
  broadcast-evm, claim-deposit, deposit-e2e, request-withdraw,
  complete-withdraw, withdraw-e2e).
- **integration-tests**: `happy-day-e2e.test.ts` (17 ordered steps: full
  deposit + withdraw round trip with golden event assertions) and
  `deposit-withdrawal-failure-refund.test.ts` (forced EVM revert → refund
  branch), both resumable via env request-ids, run against the local
  docker-compose Midnight stack + Sepolia + the fakenet response server.
- **response server** (cross-repo, solana-signet-program
  `bernard/add-response-contract`): MidnightMonitor rewritten for the new
  layout, event-driven request discovery, responses written to the signet
  contract, ledger-9 bump. Old Phase 5 is done except the dependency
  question (task D.1 below).
- **Event-driven end to end — no blind ledger polling remains.** Requests
  are discovered via SignBidirectionalEvent (signet-request-feed), responses
  via SignatureRespondedEvent / RespondBidirectionalEvent
  (signet-response-feed); the response server consumes the same feeds.
  "Poll" in the code means (1) interval-polling the indexer's
  queryContractEvents endpoint — transport, not protocol (websockets are
  banned) — and (2) events acting as TRIGGERS for an authenticated state
  read, deliberate because the response log is unauthenticated and
  event/state indexing skew must be tolerated.
- **Docs/ops**: `docs/architecture.md`, `docs/e2e-sepolia-runbook.md`,
  root docker-compose stack, /e2e and /contract-change skills,
  xcontract-events spike + knowledge base.

---

# Part 2 — Remaining migration phases

Ordered by dependency. Each task has a *Done when*. Protocol
alignment/freeze is deliberately LAST (Phase E, Finalisation) — until it
lands every deployment is throwaway (struct changes change all request
ids); that is an accepted cost while the protocol is still moving.

## Phase A — Wire-format versioning

This repo is becoming the source of truth for the final protocol wire
types (the old repo's SGN1 spec + `signer/` prototype are inputs, not the
destination). Discovery is already fully event-driven (see Part 1) — what
is missing is versioning, so that future encoding changes (compiler/runtime
value-encoding shifts, struct evolution) can coexist with deployed
consumers instead of breaking them.

- [ ] **A.1 Version the event wire format.** Adopt/adapt SGN1's
      event-name version grammar + coexistence rule ("layout change ⇒ new
      tag, old tag keeps decoding"). Codecs in `signet-events.ts` dispatch
      on tag; unknown versions surface loudly, never silently skipped.
- [ ] **A.2 Version the request-id preimage and domain tags.** Domain
      strings carry a version; a struct/layout change mints a new version
      while old ids stay resolvable.
- [ ] **A.3 Golden vectors per wire version.** Port the old repo's
      `signer/goldens` approach: vectors regenerated from the compiled
      contracts, pinnable by the MPC/Rust consumer.
      *Done when (A.1–A.3):* a simulated "v2" encoding change lands
      alongside v1 with both decodable in tests.
- [ ] **A.4 Absorb/retire `events-migration.md`.** Its Phase 1 (toolchain
      bump) is done and Phases 2–4 have largely landed; fold what is still
      live (contract topology, raw `sign` request kind, open Phase-0
      decisions) into this phase or Phase E, then delete the file.

## Phase B — Hermetic test loop + CI

In the old repo the self-contained loop WAS the CI pipeline:
`integration-tests.yml` ran `vault.api.test.ts` (in-process MPC
simulator + watcher + Hardhat TestUSDC harness + standalone stack) on
every PR — hermetic, no external funds. The refactor has no CI, and its
only integration path needs Sepolia ETH and a hand-started fakenet server.

- [x] **B.1 Port the EVM harness** (Hardhat node + TestUSDC +
      derived-address funding) into integration-tests (or a harness package).
      Done as integration-test setup, no harness package (D23): hardhat 3 +
      TestUSDC live in `packages/integration-tests`; the node is external and
      long-running (the `evm` docker compose service — anvil, chain id
      31337; hardhat is the Solidity compiler only); setup resolves the
      chain id from `EVM_RPC_URL`, deploys the token when the address has no
      code, and auto-funds both derived accounts on chain id 31337. Until B.2
      lands, a fresh local run 1 stops at the deposit signature-poll timeout
      (the fakenet responder hand-off) instead of the funding preflight.
      Commit a98256b.
- [ ] **B.2 Dockerize the real fakenet responder** (D24 — replaces the old
      "port the MPC simulator/watcher" task: a ported simulator would be a
      third implementation of the MPC logic, and CI would verify the copy
      instead of the artifact everyone runs). Ship the solana-signet-program
      response server as a compose service next to node/indexer/proof-server.
      **PAUSED until the common lib is published (D.1)** — the responder
      consumes `signet-midnight`/`signet-contract`/`lib` via cross-repo
      `link:` deps today, so an image build would have to span both repos and
      would bake in that layout. Known upstream gaps to fix in the responder
      when this resumes: (1) ~~no `EVM_RPC_URL`~~ DONE — the responder now
      honors an `EVM_RPC_URL` env override for all eip155 chains
      (solana-signet-program, bernard/add-response-contract), so the
      hand-run fakenet can already target the local EVM; (2) the Solana leg is
      unconditional at boot (`ensureInitialized()` crashes without reachable
      Solana RPC + `SOLANA_PRIVATE_KEY`/`PROGRAM_ID`/`INFURA_API_KEY`) —
      needs a Midnight-only switch for a hermetic loop; (3) the signet
      contract's gitignored zk `managed/` output (~85 MB prover key) must be
      compiled in the image or mounted from the host.
      *Done when:* a `local-loop` flow file runs deposit→claim and
      withdraw→settle green with no external network and no manual steps.
- [ ] **B.3 GitHub Actions:** compile (skip-zk) → build → unit tests on
      every push; the hermetic loop as the integration job (crib the old
      repo's workflow); zk compile as a manual/weekly row-count canary.
      The compile/build/unit-test rows can land now; the integration job
      waits on B.2.
      *Done when:* a PR shows green checks from a fresh clone.

## Phase C — Remaining flow tests

- [x] **C.1 `false-claimer.test.ts`** — DONE (2026-07-12): identity B's
      claim rejects in-circuit ("path hex does not match commitment"), the
      request stays on the ledger, identity A claims it, the drain cycles
      the EVM funds; 6/6 green. `runDepositRoundTrip` gained a `skipClaim`
      option for the arrange stage.
- [x] **C.2 `benchmark.test.ts`** — DONE (2026-07-13): deposit + withdraw
      round trips driven long-hand, one timed leg per test with an explicit
      stopwatch bracketing exactly the cli command measured (flow helpers
      carry NO timing — flows that don't measure must not time in the
      background, and a narrowed selection can benchmark a single leg);
      reports per-leg wall clock (banner table + a greppable
      `BENCHMARK_TIMINGS_JSON` line); reporting only until there is
      baseline data; 13/13 green.

## Phase D — Loose ends

- [ ] **D.1 Publish the common lib** (old 5.1, upgraded from "decide" to
      the B.2 prerequisite per D24): the response server consumes
      signet-midnight / signet-contract / lib via cross-repo `link:` deps
      today. Publish them (or settle an equivalent consumable form) so the
      responder can depend on released versions; record in both repos' logs.
      B.2 (dockerized fakenet) is paused until this lands.
- [ ] **D.2 Deployment manifest — keep or drop** (old 2.3/4.5): env-var
      resume (`DEPOSIT_REQUEST_ID` etc.) replaced it in practice. Either
      implement `deployments/<network>.json` + an ensure-deployed helper, or
      log the decision that env-vars are the mechanism and delete the idea.
- [ ] **D.3 Hardening backlog** (pull forward as needed): caip2Id↔chainId
      consistency enforcement point; TS branding for request ids; JSDoc
      sweep of early-ported code.
- [ ] **D.4 Repo hygiene + docs finish:** un-commit the stray
      `midnight-level-db/` dirs (cli, xcontract-events) if unintended;
      fold or delete root scratch notes (`scratch.md`, `changed-notes.md`)
      once absorbed; README architecture section final pass; mark the old
      repo superseded (its READING-GUIDE still points people at MVP paths)
      and plan its archival once its last unported assets (signer goldens,
      CI workflow) have moved.
- [x] **D.5 Migrate the workspace from npm to Yarn** (from the README TODO
      list). Yarn 4 via corepack (`packageManager` field), `nodeLinker:
      node-modules`, npm `overrides` → yarn `resolutions`, root aggregate
      scripts → `yarn workspaces foreach`, `runRootScript`/launch.json spawn
      yarn, docs/comments swept (npm-registry mentions and the old-repo
      Sepolia runbook deliberately kept as-is). `yarn.lock` is gitignored
      like package-lock.json was — installs keep floating to latest (D25).
      *Done when:* fresh `yarn install` + `yarn compile && yarn build &&
      yarn test` green from a clean node_modules — verified 2026-07-12
      (225 unit tests pass; integration suite env-gates to skip; the
      response server's cross-repo symlinks into this repo's node_modules
      still resolve). Commit aed77b2.

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
      folds into this — decide widths in the same pass.
      *Done when:* shapes signed off by the MPC team, recorded in the
      Decision Log, structs + TS twins + readers updated in one change,
      new row counts measured and logged.
- [ ] **E.2 Decide the attestation crypto for `respond_bidirectional`.**
      The SGN1 spec assumes secp256k1 ECDSA (off-chain verified);
      `claimDeposit` needs in-circuit verification, which today means Jubjub
      Schnorr (`ecdsa-midnight-progress.md`: secp256k1 in-circuit is
      unscheduled). Outcome needed: MPC produces the Jubjub attestation, or
      the claim flow changes.
      *Done when:* decision logged; both sides implement it.
- [ ] **E.3 Freeze + publish the versioned wire spec** (successor of the
      old repo's `signet-midnight-events.md`), co-signed by both sides,
      with golden vectors regenerable by this repo's harness and the MPC's
      Rust consumer. First long-lived deployment happens after this.

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

<!-- Append new decisions below this line. -->
