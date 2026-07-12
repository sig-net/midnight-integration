# Refactor task list — midnight-erc20-vault

**How to use this file:** single source of truth for what REMAINS of the
refactor. Work one task at a time; tick the box, append the commit hash, and
record any decision you make in the Decision Log at the bottom. Run
`npm run compile && npm run build && npm run test` before calling anything
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
      long-running (`npm run evm-node:integration-tests`); setup resolves the
      chain id from `EVM_RPC_URL`, deploys the token when the address has no
      code, and auto-funds both derived accounts on chain id 31337. Until B.2
      lands, a fresh local run 1 stops at the deposit signature-poll timeout
      (the fakenet responder hand-off) instead of the funding preflight.
- [ ] **B.2 Port the MPC simulator/watcher**, updated from the old
      websocket push to the contract-post model (read request via the event
      feeds → sign → broadcast → post response/attestation to the signet
      contract).
      *Done when:* a `local-loop` flow file runs deposit→claim and
      withdraw→settle green with no external network and no manual steps.
- [ ] **B.3 GitHub Actions:** compile (skip-zk) → build → unit tests on
      every push; the hermetic loop as the integration job (crib the old
      repo's workflow); zk compile as a manual/weekly row-count canary.
      *Done when:* a PR shows green checks from a fresh clone.

## Phase C — Remaining flow tests (work order: `src/flows/TODO.md`)

- [ ] **C.1 `false-claimer.test.ts`** — prove identity B cannot claim
      identity A's deposit; leave no stranded funds.
- [ ] **C.2 `benchmark.test.ts`** — per-leg wall-clock report from the
      `timings` the flow helpers already emit; reporting only until there is
      baseline data.

## Phase D — Loose ends

- [ ] **D.1 Response-server dependency decision** (old 5.1): it consumes
      signet-midnight via a file symlink today. Decide npm publish vs
      `file:` dep vs vendoring; record in both repos' logs.
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
external and long-running (`npm run evm-node:integration-tests`, parallel to
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

<!-- Append new decisions below this line. -->
