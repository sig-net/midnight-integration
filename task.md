# Refactor task list — midnight-protocol (formerly midnight-erc20-vault)

**How to use this file:** single source of truth for what REMAINS of the
refactor. Work one task at a time; tick the box, append the commit hash, and
record any decision you make in the Decision Log at the bottom. Run
`yarn compile && yarn build && yarn test` before calling anything done. Read
`/AGENTS.md` + the member `AGENTS.md` of any package you touch — those rules
are non-negotiable.

This file was rewritten 2026-07-17 after the erc20-vault example was split out
to `sig-net/midnight-examples` and a final main↔refactor↔examples test-coverage
recon ran (D29). Earlier rewrites: 2026-07-12 (D20, post-port comparison) and
2026-07-15 (D27, four-track comparison). The full history — original Phases
0–10, Phases A–E as previously scoped, Decision Log D1–D28 — is in git:
`git log --follow -- task.md`.

## Context in brief

This repo is now the **protocol repo**: the Signature Network singleton
contract + SDK (`packages/signet-midnight`, `signet-contract`,
`signet-contract-deploy`, a pruned `lib`), a **minimal generic caller**
(`packages/caller-contract`) with its e2e suite (`packages/integration-tests`),
and the `packages/xcontract-events` research exception (knowledge-base is the
value). The ERC20 vault example — contract, flows, five e2e specs, test
harness — was ported to `~/Projects/github.com/sig-net/midnight-examples`
(branch `port/erc20-vault`, **PR #1, open**) and deleted here; that port's plan
lives in the examples repo's `TASK.md`.

Naming: the GitHub repo was renamed `midnight-erc20-vault` →
`midnight-integration` (2026-07-17; `origin` updated, redirect active). The
intended final name is **`midnight-protocol`** — a protocol repo with only the
minimal caller example. Local checkout directories still carry the old name.

Repo topology (matters for A.3 and branch cleanup): the old MVP checkout
(`~/Projects/github.com/sig-net/midnight-erc20-vault`) and this checkout are
WORKTREES of one git repository. `origin/main` was merged into
`bernard/repo-refactor` at `eab05a3` keeping this branch's deletions — main's
final PR #3 content (`boilerplate/`) exists in history only. The last unported
assets sit on `feat/signet-signer-ledger9`: `signer/goldens/*.json`,
`signer/README.md`, `READING-GUIDE.md` (read via
`git show feat/signet-signer-ledger9:<path>`). Do NOT delete that branch
before A.3 ports the goldens.

---

# Part 1 — State (verified 2026-07-17)

Everything through the example-split's Phase 8 is done and green: singleton +
SDK + caller contract + generic `signet-caller-e2e` against the local docker
stack; CI (`.github/workflows/ci.yml`: unit / integration / zk-canary) landed
via PR #16 with a green fresh-chain run — the former B.3 is DONE. The examples
repo is green through its Phase 6 fresh-clone verification (unit suites + five
e2e specs + its own CI).

## Final test-coverage check — main vs (refactor ∪ examples)

Every test on `origin/main` (tip `99ee0c6`, includes PR #3) mapped to a twin:

| main (`boilerplate/`) | twin | verdict |
|---|---|---|
| `vault.api.test.ts` (hermetic suite incl. PR #3 reshape) | examples `contract/tests/erc20-vault.test.ts` (~40 cases) | ✅ covered: permissionless success settle, recipient-only refund + stranger-cannot-refund, forged/wrong-key/tampered/replayed attestations, wrong-color coin, value mismatch, claim identity, rid-salted domain-separated `withdrawRefundCommitment`, big-endian address |
| `vault.api` “refund to second wallet” (removed on main) | — | ✅ no twin needed: caller-chosen refundPk removed by design (recipient-only refund) |
| `vault.e2e.test.ts` STEPs 1–7 + 4 claim rejections | examples five e2e specs; claim rejections in the simulator suite | ✅ covered |
| `vault.e2e.test.ts` STEP 8 (bearer-transfer handoff) | **none** — `transferTransaction` appears nowhere in either repo | ❌ GAP → R.1 |
| `vault.api` #10 over-balance withdraw (wallet-level) | none live (only Uint<64>-max asserts) | ⚠ minor gap → R.3 |
| `evm-harness.verify.test.ts`, `fund-wallet.test.ts` | examples `test-harness/scripts/stack-smoke.ts` + per-spec funding/initialized preflights | ✅ covered (better) |
| `mpc-simulator.ts`, `mpc-watcher.ts`, `evm-harness.ts`, `commons.ts` | dockerized real fakenet responder | ✅ by decision (old D24: no simulator port) |
| `counter.api.test.ts` | — | ✅ boilerplate, deliberately dropped |
| `deserialize.test.ts` | — | ✅ superseded (output schema is a single bool word) |
| `.github/workflows/integration-tests.yml` | this repo's `ci.yml`; examples' workflows | ✅ covered |
| `setup-preview-wallet.ts` (new in PR #3; a utility, not a test) | none | ❌ unported → D.7 |
| `kernel.checkpoint()` in withdraw (PR #3 segment-safety fix) | examples vault has NO checkpoint and a fallible cross-contract notify after the coin take | ❌ open question → R.2 |
| distinct stale-nonce dest (`f97f50b`, test hygiene) | n/a — examples forces the failure by draining the vault, so the same-tx-hash trap can't occur | ✅ n/a |
| unlinkable withdraw refund tag (`281ea8f`) | examples `withdrawRefundCommitment` domain-separation test | ✅ covered |

Verdict: merging `bernard/repo-refactor` → `main` loses **no test coverage**
that isn't (a) deliberately superseded or (b) recorded below as R.1–R.4
examples-repo work.

---

# Part 2 — Remaining work

## Merge gate — do these, then PR `bernard/repo-refactor` → `main`

- [ ] **M.1 Repo identity rename.** Root `package.json` `name:
      midnight-erc20-vault` (and the two `workspaces foreach --exclude
      midnight-erc20-vault` scripts), workspace scopes
      `@midnight-erc20-vault/{lib,caller-contract,integration-tests}` (+ the
      `packages/lib/AGENTS.md` heading), `AGENTS.md` H1, `README.md` title +
      package tree. Pick the scope to match the final repo name
      (`midnight-protocol`). The GitHub rename `midnight-integration` →
      `midnight-protocol` is a USER action; update `origin` after it.
- [ ] **M.2 Sepolia runbook decision.** `docs/e2e-sepolia-runbook.md` documents
      code that no longer exists here (`vault.e2e.test.ts`, `yarn response`,
      `boilerplate/contract-cli` paths). Delete it (the vault flow's home is
      the examples repo now), or move the still-useful parts (fakenet signer
      notes, Sepolia funding lore) to the examples repo. Don't keep the decoy.
- [ ] **M.3 Root `scratch.md`.** Now holds a decent high-level Signet overview
      (not scratch). Fold it into `README.md` or `docs/`, or delete it —
      untracked scratch must not ride into the merged main.
- [ ] **M.4 README `## TODOs` block.** Folded into the Backlog section below —
      remove the block from `README.md` (README is a front door, not a
      tracker).
- [ ] **M.5 `--passWithNoTests` cleanup.** Drop it from `signet-midnight`
      (11 test files) and `xcontract-events` (2); keep it on `lib` (its tests
      were pruned away with its former surface) with a one-line comment, or
      give lib a minimal test.
- [ ] **M.6 Open the PR** `bernard/repo-refactor` → `main`. Merging the
      examples PR #1 is a user action, sequenced with this (either order — the
      coverage table above holds for both).

## Relocated to midnight-examples (recorded here so nothing is lost; NOT tasks in this repo)

- **R.1 Bearer-transfer ownership handoff test** (old STEP 8; the only main
  test scenario with no twin anywhere): transfer vault tokens A→B, assert A
  (balance 0) can no longer fund a withdraw and B can. Cheapest home: the
  simulator suite; a live variant can ride an existing e2e flow.
- **R.2 Withdraw segment safety.** The examples vault's `withdraw` does
  `receiveShielded` then a fallible CROSS-CONTRACT
  `notifyBidirectionalSignatureRequest` with no `kernel.checkpoint()`. Main
  resolved its own version (PR #3): checkpoint after the take, with only pure
  same-contract writes after it. That exact fix does NOT transplant — a
  checkpoint before the examples' fallible notify would let the coin take
  stand while the notify fails (stranding), whereas one segment means a failed
  notify presumably reverts the take too. Verify Compact's segment semantics
  for this layout (force the notify to fail, observe the coin) or restructure;
  log the outcome. The caller contract is exempt (no coin take).
- **R.3 Over-balance live withdraw assert** (old #10 — wallet-level, no
  simulator twin): cheap rider on an existing examples e2e spec.
- **R.4 `setup-preview-wallet.ts`** (Preview-network wallet onboarding: print
  address, wait for faucet NIGHT, register dust, confirm fee balance). Exists
  only in main's history (`git show origin/main:boilerplate/contract-cli/src/setup-preview-wallet.ts`).
  Port to the examples repo if Preview/testnet onboarding is a target — see
  D.7 for this repo's half.

## Phase A — Wire-format versioning

This repo is the source of truth for the final protocol wire types. Discovery
is registry-polling; what's missing is versioning so encoding changes can
coexist with deployed consumers.

- [ ] **A.1 Version the notification wire format.** The `{ version, payload }`
      envelope + fail-closed decoder are in. Remaining: the coexistence rule
      ("layout change ⇒ new version, old version keeps decoding") once a V2
      exists.
- [ ] **A.2 Version the request-id preimage and domain tags.** Domain strings
      carry a version; a struct/layout change mints a new version while old
      ids stay resolvable.
- [ ] **A.3 Golden vectors per wire version.** Port the `signer/goldens`
      approach from `feat/signet-signer-ledger9` (`signer/goldens/*.json` +
      `signer/README.md`): vectors regenerated from the compiled contracts,
      pinnable by the MPC/Rust consumer.
      *Done when (A.1–A.3):* a simulated "v2" encoding change lands alongside
      v1 with both decodable in tests.

## Phase D — Loose ends

- [ ] **D.2 Deployment manifest — keep or drop.** Env-var resume
      (`CALLER_REQUEST_ID` in the caller e2e) replaced it in practice. Either
      implement `deployments/<network>.json` + an ensure-deployed helper, or
      log the decision that env-vars are the mechanism and delete the idea.
- [ ] **D.3 Hardening backlog (slimmed — the old JSDoc misses died with the
      lib prune):** caip2Id↔chainId consistency enforcement point; TS branding
      for request ids.
- [ ] **D.7 Dev-convenience / non-local onboarding — decide or port (low).**
      generate-key / check-balance / request-faucet wrappers, plus this repo's
      half of `setup-preview-wallet.ts` (R.4): the caller e2e also needs a
      funded wallet on any non-local network. Matters only if Preview/testnet
      is a target (the local loop auto-funds). Either add thin commands or log
      that the local flow covers it.
- [ ] **D.8 Onboarding doc decision.** The old `READING-GUIDE.md` (on
      `feat/signet-signer-ledger9`) has no successor — write this repo's own
      reading guide or log that it dies with the old layout.
- [ ] **D.9 Post-merge branch/worktree cleanup.** After M.6 merges: retire the
      old-MVP worktree (its remote branch is already deleted), archive stale
      branches — but keep `feat/signet-signer-ledger9` until A.3 has the
      goldens. `boilerplate/` then exists only in history (that is the record;
      nothing further to archive).
- [ ] **D.10 Caller-e2e smoke check (low; pull forward if flows fail
      mid-run).** Successor of the old infra-smoke idea for THIS repo's suite:
      a cheap first assertion that compose services and fakenet are alive
      before the slow proven flow. The examples repo already has its own
      (stack-smoke + preflights).

## Phase E — Finalisation: protocol alignment & freeze

Joint work with the MPC/signer colleague; deliberately LAST — every deployment
before it is throwaway (struct changes change all request ids). Note: the old
`alignment.md` / `ecdsa-midnight-progress.md` sub-plans were deleted (commit
`d68c830`) — their checklists are in git history; resurrect what E.1 needs.

- [ ] **E.1 Align request/response structs with the MPC-canonical shapes.**
      Request-id scheme (whole-struct `persistentHash` vs tails-hash),
      `SignetMPCRoutingParams` (`path` → `commitment: Bytes<32>`?),
      `EVMCalldata` field order, response struct names, commitment domain
      string. Field right-sizing (path 256→64 etc.) folds in — decide widths
      in the same pass. Confirm in the same sign-off the two intentional
      divergences from the MVP: the attestation-message preimage
      (`hash(hash(output: Bytes<128>), outputLen)`) and the Schnorr challenge
      reduction (`as JubjubScalar` cast) — both must match the MPC signer
      exactly.
      *Done when:* shapes signed off, logged, structs + TS twins + readers
      updated in one change, new row counts measured.
- [ ] **E.2 Decide the attestation crypto for `respond_bidirectional`.**
      SGN1 assumes secp256k1 ECDSA; in-circuit verification today means
      Jubjub Schnorr (secp256k1 in-circuit is unscheduled). Outcome needed:
      MPC produces the Jubjub attestation, or the claim flow changes.
- [ ] **E.3 Freeze + publish the versioned wire spec**, co-signed by both
      sides, with golden vectors regenerable by this repo's harness and the
      MPC's Rust consumer. First long-lived deployment happens after this;
      that pass also documents non-local network bring-up (the repo is
      local-only by design until then).

## Backlog (folded from README TODOs per M.4; unscheduled, most overlap Phase A/E)

- Deploy scripts: allow rejoining and upgrading existing contract deployments
  (overlaps D.2).
- Remove unnecessary padding from the signing request to shrink circuits /
  proving time (overlaps E.1 field-sizing).
- Move generic types into signet.js.
- Generics so client contracts specify their calldata argument count.
- Replace `SignetEVMSignatureRequest` with a canonical signet.js
  `EVMSignatureRequest` type (if/when it exists).
- Add V1 to every struct (overlaps A.1/A.2).
- Witness-provided nonce randomness in requests + nonce evolution.

---

# Part 3 — Decision Log

Append-only. D1–D28 (single-map index, whole-struct request ids, npm→Yarn 4,
no-simulator-port, events purge → notification registry, CI-as-developer-
commands, …) are in git history of this file. Never reference task.md from
anywhere outside this file.

### D29 — Example split executed; final coverage recon; remaining work re-scoped (2026-07-17)
**Decision:** The erc20-vault example (contract, flows, five e2e specs,
harness) now lives in `sig-net/midnight-examples` (PR #1, branch
`port/erc20-vault`; plan in that repo's TASK.md); this repo was pruned to
singleton + SDK + minimal caller + xcontract-events (its split Phases 7–8).
`origin/main` merged into the branch at `eab05a3` keeping the deletions —
main's PR #3 lives in history only. A final test-coverage check (table in
Part 1) confirmed no coverage is lost by the merge; the four findings were
recorded as R.1–R.4 (examples-repo work): bearer-handoff test, withdraw
segment-safety verification (main's checkpoint fix does not transplant across
the cross-contract notify), over-balance live assert, `setup-preview-wallet`
port. task.md was rewritten to the merge gate (M.1–M.6) + Phases A/D/E;
B.3 (CI) ticked done (PR #16 merged, green fresh-chain run); C.1/C.2 done in
suites that since moved; old D.4 hygiene items verified done en route
(placeholder.sh gone, README banner + truncated Criteria gone, AGENTS.md
emit carve-out documented, architecture.md moved with the example,
xcontract-events kept as the documented exception) except those carried as
M.2–M.5; D.6/C.3/C.4 relocated or slimmed (R.2/R.1/D.10). The repo's
destination name is `midnight-protocol` (GitHub currently
`midnight-integration`).
**Impact:** none on code; this file is the only artifact.

<!-- Append new decisions below this line. -->
