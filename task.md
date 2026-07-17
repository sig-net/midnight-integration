# Task list — midnight-protocol (formerly midnight-erc20-vault)

**How to use this file:** single source of truth for what REMAINS in this repo.
Work one task at a time; tick the box, append the commit hash, and record
decisions in the Decision Log. Run `yarn compile && yarn build && yarn test`
before calling anything done. Read `/AGENTS.md` + the member `AGENTS.md` of any
package you touch.

Rewritten 2026-07-17 (twice — first the post-split merge-gate version with the
full main↔refactor↔examples coverage recon, commit `3ad0ade`; then this slim
version). The refactor itself is DONE: this repo is the Signature Network
singleton + SDK + a minimal generic caller with its e2e suite (+ the
`xcontract-events` knowledge-base exception); the erc20-vault example moved to
`sig-net/midnight-examples` (PR #1). The coverage recon confirmed merging
`bernard/repo-refactor` → `main` loses no test coverage; the two substantive
findings (bearer-handoff test, withdraw segment-safety verification) are
tracked in the EXAMPLES repo's TASK.md, not here. Full history — original
plan, phases, coverage table, Decision Log D1–D29 — via
`git log --follow -- task.md`.

Two facts that must survive until used:
- The GitHub repo is `sig-net/midnight-integration`; the intended final name
  is **`midnight-protocol`** (rename = user action on GitHub).
- Branch `feat/signet-signer-ledger9` holds the signer golden vectors
  (`signer/goldens/*.json`, `signer/README.md`) and `READING-GUIDE.md` — do
  NOT delete it before task 2.3 ports the goldens.

---

## 1 — Docs & identity cleanup (the merge gate: do these, then PR `bernard/repo-refactor` → `main`)

- [ ] **1.1 Repo identity rename** (started: `66c7dd8` README updates). Root
      `package.json` `name: midnight-erc20-vault` + the two
      `workspaces foreach --exclude midnight-erc20-vault` scripts; workspace
      scopes `@midnight-erc20-vault/{lib,caller-contract,integration-tests}`
      (+ `packages/lib/AGENTS.md` heading); `AGENTS.md` H1; `README.md` title
      + package tree. Pick the scope to match `midnight-protocol`. Update
      `origin` after the GitHub rename.
- [ ] **1.2 Delete or relocate `docs/e2e-sepolia-runbook.md`.** It documents
      code that no longer exists here (vault e2e, `yarn response`,
      `boilerplate/` paths); the vault's home is the examples repo. Move any
      still-useful fakenet/Sepolia lore there; don't keep the decoy.
- [ ] **1.3 Root `scratch.md`** (untracked): its Signet overview is good —
      fold into `README.md` or `docs/`, or delete. Nothing untracked rides
      into main.
- [ ] **1.4 README `## TODOs` block** → already folded into §3 below; remove
      the block from `README.md`.
- [ ] **1.5 `--passWithNoTests`:** drop from `signet-midnight` (11 test files)
      and `xcontract-events` (2); keep on `lib` (tests were pruned with its
      surface) with a one-line comment, or give lib a minimal test.
- [ ] **1.6 Open the PR** `bernard/repo-refactor` → `main`; after merge:
      retire the old-MVP worktree, archive stale branches (KEEP
      `feat/signet-signer-ledger9` until 2.3), and decide whether the old
      `READING-GUIDE.md` gets a successor here or dies with the old layout.

## 2 — Freeze the protocol types (joint work with the MPC/signer side; every deployment before this is throwaway)

Versioning first, so future encoding changes can coexist with deployed
consumers; then alignment + freeze. The old `alignment.md` /
`ecdsa-midnight-progress.md` checklists were deleted (`d68c830`) — resurrect
from git history as needed.

- [ ] **2.1 Version the wire formats.** The notification envelope
      (`{ version, payload }`, fail-closed decoder) is in; add the coexistence
      rule ("layout change ⇒ new version, old version keeps decoding") and
      version the request-id preimage / domain tags so a struct change mints a
      new version while old ids stay resolvable.
- [ ] **2.2 Align request/response structs with the MPC-canonical shapes.**
      Request-id scheme (whole-struct `persistentHash` vs tails-hash),
      `SignetMPCRoutingParams` (`path` → `commitment: Bytes<32>`?),
      `EVMCalldata` field order, response struct names, commitment domain
      string; field right-sizing (path 256→64 etc.) in the same pass. Confirm
      the two intentional divergences from the MVP in the same sign-off: the
      attestation-message preimage (`hash(hash(output: Bytes<128>),
      outputLen)`) and the Schnorr challenge reduction (`as JubjubScalar`
      cast) — both must match the MPC signer exactly. Also settle the
      attestation crypto for `respond_bidirectional`: SGN1 assumes secp256k1
      ECDSA, but in-circuit verification today means Jubjub Schnorr — either
      the MPC produces the Jubjub attestation, or the claim flow changes.
- [ ] **2.3 Golden vectors per wire version.** Port the `signer/goldens`
      approach from `feat/signet-signer-ledger9`: vectors regenerated from the
      compiled contracts, pinnable by the MPC/Rust consumer.
- [ ] **2.4 Freeze + publish the versioned wire spec**, co-signed by both
      sides, with golden vectors regenerable by this repo's harness and the
      MPC's Rust consumer. First long-lived deployment happens after this;
      that pass also documents non-local network bring-up (the repo is
      local-only by design until then).
      *Done when (2.1–2.4):* shapes signed off and logged; structs + TS twins
      + readers updated in one change; new row counts measured; a simulated
      "v2" encoding change lands alongside v1 with both decodable in tests.

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
- From the old README TODOs: deploy-script rejoin/upgrade of existing
  deployments; strip unnecessary request padding (→ 2.2 field-sizing); move
  generic types into signet.js; generics for client calldata arg count;
  canonical `EVMSignatureRequest` from signet.js; `V1` on every struct
  (→ 2.1); witness-provided nonce randomness + nonce evolution.

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

<!-- Append new decisions below this line. -->
