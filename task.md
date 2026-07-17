# Task list — midnight-protocol (formerly midnight-erc20-vault)

**How to use this file:** single source of truth for what REMAINS in this repo.
Work one task at a time; tick the box, append the commit hash, and record
decisions in the Decision Log. Run `yarn compile && yarn build && yarn test`
before calling anything done. Read `/AGENTS.md` + the member `AGENTS.md` of any
package you touch.

Rewritten 2026-07-17 (twice — first the post-split merge-gate version with the
full main↔refactor↔examples coverage recon, commit `3ad0ade`; then this slim
version). The refactor itself is DONE: this repo is the Signature Network
singleton + SDK + a minimal generic caller with its e2e suite; the erc20-vault
example moved to `sig-net/midnight-examples` (PR #1), and the
`xcontract-events` research spike (+ its knowledge-base) moved to
`BRBussy/midnight-experiments` (2026-07-17). The coverage recon confirmed merging
`bernard/repo-refactor` → `main` loses no test coverage; the two substantive
findings (bearer-handoff test, withdraw segment-safety verification) are
tracked in the EXAMPLES repo's TASK.md, not here. Full history — original
plan, phases, coverage table, Decision Log D1–D29 — via
`git log --follow -- task.md`.

One fact that must survive until used: the GitHub repo is
`sig-net/midnight-integration`; the intended final name is
**`midnight-protocol`** (rename = user action on GitHub).

Branch `feat/signet-signer-ledger9` is DEAD (confirmed with its author,
2026-07-17): the golden vectors this branch needs are already here (the
golden-vectored crypto tests in `packages/signet-midnight/tests`), and its
`READING-GUIDE.md` dies with it. It can be deleted in the post-merge cleanup.

---

## 1 — Docs & identity cleanup (the merge gate: do these, then PR `bernard/repo-refactor` → `main`)

- [x] **1.1 Repo identity rename: DONE (2026-07-17, `dcc4d37`;** started
      `66c7dd8` README updates**).** Root `package.json` name + the
      `workspaces foreach --exclude` scripts renamed to `midnight-protocol`;
      workspace scopes now
      `@midnight-protocol/{lib,caller-contract,integration-tests}` (imports,
      `packages/lib/AGENTS.md` heading and `AGENTS.md` H1 updated with them).
      README title/tree carried no old identity after `66c7dd8`. The two
      `erc20-vault` mentions left in `signet-midnight` comments refer to the
      examples repo / MPC responder, not this repo. STILL PENDING: update
      `origin` once the GitHub rename to `midnight-protocol` happens (user
      action; still `sig-net/midnight-integration` as of 2026-07-17).
- [x] **1.2 Sepolia runbook + sweep script — DONE (2026-07-17).** The parked
      Sepolia derived-account funds were swept back to the funding wallet
      `0xFBdC76c2aaB313484d1b8E63B75D38efD0537680` (~0.0142 ETH + 4.4 USDC
      recovered; sub-gas dust and one unrecoverable 0.1 USDC abandoned), then
      `docs/e2e-sepolia-runbook.md` and `scripts/sweep-derived-funds.ts` were
      deleted (both in git history at `9c42d6e`).
- [X] **1.3 Root `scratch.md`** (untracked): its Signet overview is good —
      fold into `README.md` or `docs/`, or delete. Nothing untracked rides
      into main. NOT DOING. scratch.md is an ignored file.
- [x] **1.4 README `## TODOs` block** — DONE (README tidy, 2026-07-17): block
      removed; its items live in §3 / task.md §2.
- [x] **1.5 `--passWithNoTests`: DONE (2026-07-17, `a6a8ced`).** Dropped from
      both `signet-midnight` (its 11 test files made it dead) and `lib`: the
      give-lib-a-minimal-test option was taken, a real offline test of
      `createCrossContractProofServerProvider`'s construction contract (the
      documented empty-providers throw + happy-path build), in
      `packages/lib/tests/` (added to lib's tsconfig `include`). No
      `--passWithNoTests` remains in the repo.
- [ ] **1.6 Open the PR** `bernard/repo-refactor` → `main`; after merge:
      retire the old-MVP worktree and delete stale branches (including the
      dead `feat/signet-signer-ledger9`).

## 2 — Finalisation: shrink the signing requests (if possible), then freeze

Per Bernard (2026-07-17) this is the required finalisation: try to REDUCE THE
SIZE of the signing requests — smaller structs ⇒ smaller circuits, faster
proving. Struct changes change all request ids, so redeploys are the accepted
cost until this lands; freeze after it.

- [ ] **2.1 Baseline measurement.** Record circuit rows + prove time per
      request circuit before touching anything (row counts print at keygen —
      the zk-canary CI job logs them; the examples repo's `benchmark.test.ts`
      times the live legs; the BRBussy/midnight-experiments bench repo has the
      circuit/proof-size study method).
- [ ] **2.2 Reduce.** Remove unnecessary padding from the request structs and
      right-size fields (e.g. `path` 256→64, the padded func-sig/schema
      fields); consider generics so client contracts specify their calldata
      arg count instead of paying for the max. Structs + TS twins + readers/
      decoders + fakenet consumer updated in ONE change; re-measure and log
      the delta. "Not meaningfully reducible" is a valid, loggable outcome.
- [ ] **2.3 Freeze.** Republish `@sig-net/midnight*` with the final shapes,
      bump the fakenet responder pins, record final row counts in the
      Decision Log. First long-lived deployment happens after this.

## 3 — Backlog (unscheduled; decide-or-drop, most fold into §2)

- Env-var resume (`CALLER_REQUEST_ID`) vs a `deployments/<network>.json`
  manifest — log the decision either way.
- Hardening: caip2Id↔chainId consistency enforcement point; TS branding for
  request ids.
- Dev-convenience wrappers (generate-key / check-balance / faucet-wait à la
  the old `setup-preview-wallet.ts` — primitives all ported, only wrappers
  missing); matters only if Preview/testnet becomes a target.
- Caller-e2e smoke check (fast stack-liveness assert before the slow proven
  flow); pull forward only if runs keep dying mid-flow.
- Wire-format versioning beyond the existing `{ version, payload }`
  notification envelope: the coexistence rule ("layout change ⇒ new version,
  old keeps decoding"), versioned request-id domain tags, `V1` on every
  struct, golden vectors per wire version.
- MPC-side alignment sign-off, if it resurfaces: request-id scheme
  (whole-struct `persistentHash` vs tails-hash), routing params / calldata
  field order / domain strings; the two intentional MVP divergences
  (attestation-message preimage `hash(hash(output),outputLen)`, Schnorr
  challenge via `as JubjubScalar`) must match the MPC signer exactly; the
  `respond_bidirectional` crypto question (SGN1 says secp256k1 ECDSA,
  in-circuit means Jubjub Schnorr). Old checklists: `alignment.md` /
  `ecdsa-midnight-progress.md` in git history (`d68c830`).
- From the old README TODOs: deploy-script rejoin/upgrade of existing
  deployments; move generic types into signet.js; canonical
  `EVMSignatureRequest` from signet.js; witness-provided nonce randomness +
  nonce evolution.

---

## Decision Log

Append-only. D1–D29 in git history (`git log --follow -- task.md`); never
reference task.md from outside this file.

### D30 — task.md slimmed to this repo's own remaining work (2026-07-17)
**Decision:** Split the remaining work cleanly between repos: the two KEY
coverage findings (bearer-transfer handoff test; withdraw segment-safety /
`kernel.checkpoint()` verification) moved to the examples repo's TASK.md,
since the vault contract lives there. This repo keeps: the merge gate (§1,
docs + identity cleanup), the protocol-type freeze (§2 = former Phases A + E
folded), and a decide-or-drop backlog (§3). `setup-preview-wallet` was
verified redundant (dust-registration and wait primitives ported in both
repos; only thin wrappers missing — §3).
**Impact:** none on code; this file and the examples TASK.md are the artifacts.

### D31 — ledger9 branch is dead; finalisation = shrink the signing requests (2026-07-17)
**Decision:** Per Bernard (after talking to the branch's author):
`feat/signet-signer-ledger9` is dead — the goldens this repo needs are the
golden-vectored crypto tests already in `packages/signet-midnight/tests`, and
`READING-GUIDE.md` dies with the branch (delete it in the post-merge cleanup;
the keep-until-goldens-ported guardrail in D29/D30 is void). The finalisation
work (§2) is re-scoped to: measure → reduce the signing-request size (padding,
field widths, calldata-arg generics) if possible → freeze/republish. The
former Phase A/E material (wire versioning, MPC alignment sign-off,
attestation-crypto question) moved to the §3 backlog — recorded, unscheduled.
**Impact:** none on code; frees the post-merge branch cleanup.

### D32 — xcontract-events moved to BRBussy/midnight-experiments (2026-07-17)
**Decision:** Per Bernard: the `packages/xcontract-events` research spike
(cross-contract calls + MIP-0002 events, incl. its `knowledge-base/`) moved
out of the protocol repo into the `BRBussy/midnight-experiments` workspace
(commit `3c5cee6` there: rescoped to `@midnight-experiments/xcontract-events`,
lib dep redirected to `@midnight-experiments/lib` — same provider helpers —
deploy dep pinned to npm `@sig-net/midnight-contract-deploy@^0.0.3`; compile,
build and 6 unit tests green in the new home). The old D27-era "documented
exception" keeping it here is void; this repo is now exactly singleton + SDK
+ caller + e2e. `packages/lib` keeps both provider helpers — caller-contract
still consumes them.
**Impact:** workspace member removed; README/AGENTS.md rows dropped.

<!-- Append new decisions below this line. -->
