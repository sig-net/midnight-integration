# Refactor task list — midnight-erc20-vault

Working order for finishing the rewrite. Each task has a **Done when** — don't
move on until it holds. Rules from `AGENTS.md` apply throughout (compile before
build/test, simulator-only unit tests, latest deps, JSDoc on exports).

Old-repo references: `~/Projects/github.com/sig-net/midnight-erc20-vault`
(contract: `boilerplate/contract/src/erc20-vault.compact`, off-chain:
`boilerplate/contract-cli/src/signet/`, runbook: `docs/e2e-sepolia-runbook.md`).
Response server: `~/Projects/github.com/sig-net/solana-signet-program/clients/response-server/`.

---

## Phase 0 — Library abstraction ✅ done

- [x] `SignetRequests.compact` shared module: request structs (EVM tx /
      calldata / MPC routing), nominal `SignetRequestId`, domain-separated
      whole-struct request-id hash, path↔identity binding circuits.
- [x] TS twins + MPC-style raw `state-reader.ts`, tripwire tests both sides.
- [x] Compiled pure circuits (`circuits.compact`, skip-zk) as the executable
      reference implementation.
- [x] Vault `deposit` ported in full + deployer-gated `initialize` config.
- [x] Measured: deposit k=19 rows=419,499 (MVP: 454,021) — no regression.

## Phase 1 — Finish the deposit flow (simulator level)

- [ ] **1.1 Export `userCommitment` for off-chain use.** Move it (and the
      `"vault:user:"` domain tag) into `SignetRequests.compact`? No — it is
      vault-specific; instead re-export it from the vault's compiled output
      (`export { userCommitment }` alongside `deposit`) so TS can compute the
      deployer/caller commitment without re-porting the hash.
      *Done when:* `pureCircuits.userCommitment(sk)` callable from vault tests.
- [ ] **1.2 Deposit round-trip simulator test.** Call `deposit` through the
      simulator (real witness, path built as hex of commitment), then assert
      the SAME record comes back three ways: generated `ledger()` read, shared
      `toSignetEVMSignatureRequestIndex`, and raw
      `readSignetEVMSignatureRequestIndexFromState`. This closes the last
      decode-correctness gap (raw reader has only seen synthetic trees).
      *Done when:* all three reads deep-equal the input; request id in the map
      key matches `pureCircuits.signetEVMSignatureRequestId(record)`.
- [ ] **1.3 Validation + gating tests.** initialize: deployer-gated, one-shot.
      deposit: rejects when uninitialized, zero address, zero/oversized
      amount, `to != erc20`, nonzero value, duplicate request; nonce
      increments; wrong-identity path rejected.
      *Done when:* each assert in the contract has a test that trips it.
- [ ] **1.4 Protocol-freeze pass on the request layout.** Before anything
      deploys persistently: right-size the padded fields (path 256→64,
      funcSig/schemas/params/caip2Id/dest honest maxima — ~75% of hashed bytes
      are padding; expect ~419K→~200K rows), confirm `Vector<4>` args, and
      stamp the domain tag. Re-measure with one `compile:zk`.
      *Done when:* widths are deliberate, measured, and recorded in the module
      header; TS twins + state-reader descriptors updated in the same change.

## Phase 2 — Deploy tooling

- [ ] **2.1 Port `buildDeployTransaction`** in `packages/deploy/src/deploy.ts`
      from midday's `app/ui/lib/actions/buildDeployTransaction.ts` (see
      package README): compiled-contract binding from `managedDirPath`,
      deterministic address, serialized unproven deploy tx. Constructor args
      must be supported (vault needs `deployerCommitment`).
      *Done when:* unit test builds a deploy tx for the vault's managed output
      (zk keys required → gate the test on `compile:zk` output existing).
- [ ] **2.2 Port wallet/provider plumbing into `packages/lib`** from the old
      repo's contract-cli (config, indexer/node/proof-server providers, wallet
      build/restore, logging). ONE copy; deploy + integration-tests consume it.
      *Done when:* lib exposes typed env config + provider builders with JSDoc,
      no per-package copies anywhere.
- [ ] **2.3 Vault `deploy.ts`**: compile:zk → build deploy tx → sign/prove/
      submit via lib wallet → call `initialize(vaultEvmAddress)` → write a
      **deployment manifest** (`deployments/<network>.json`: address,
      constructor args, contract-source hash, timestamp). The manifest is what
      lets every later stage SKIP redeploying.
      *Done when:* `npm run deploy -w vault-contract` against a local stack
      produces a manifest and an initialized contract.

## Phase 3 — Local stack + deployment verification

- [ ] **3.1 Local Midnight stack script** (docker compose: node/validator,
      indexer, proof server — port from old repo / midnight examples into
      root `scripts/` or `packages/lib`). Include a health-check helper that
      waits for all three.
      *Done when:* one command brings the stack up healthy from scratch.
- [ ] **3.2 Deploy vault to local stack and verify from the outside.** Query
      the deployed address via the indexer with NO compiled contract — raw
      `readSignetEVMSignatureRequestIndexFromState` sees an empty map at
      field 0, `signetNonce` counter at field 1.
      *Done when:* a script/test proves the MPC-convention read works against
      a real indexer, not just the simulator.

## Phase 4 — Integration-test orchestration (deposit half)

- [ ] **4.1 Scaffold `packages/integration-tests`** (vitest, env-gated: skips
      cleanly when no stack is up; AGENTS.md forbids these at unit level).
- [ ] **4.2 "Ensure deployed" helper — deploy once, reuse forever.** Reads the
      deployment manifest; verifies the address still answers (indexer query +
      field-0 shape check + source-hash match); deploys fresh only if missing
      or stale. This is the "don't compile and deploy each time" requirement.
      *Done when:* second run of the suite reuses the first run's contract.
- [ ] **4.3 Deposit integration test:** build path from caller commitment,
      call `deposit` via real providers/wallet, then poll the indexer and
      decode the request with the shared state reader; recompute the request
      id via compiled circuits and assert it matches the map key.
      *Done when:* deposit lands on a real chain and the MPC-style read
      returns exactly what was submitted.

## Phase 5 — Response server (cross-repo: solana-signet-program)

- [ ] **5.1 Decide how the response server consumes signet-midnight** (npm
      publish vs file: dep vs copy). Record the decision in both repos.
- [ ] **5.2 Rewrite `MidnightMonitor` for the new layout:** poll `signetNonce`
      (field 1) for cheap change detection; read field 0 via the shared state
      reader; verify each record's map key by recomputing the id with the
      compiled circuits; drop ALL fixed-index IDX table code and the
      calldata compound-key logic.
      *Done when:* monitor pointed at the Phase-3 local deployment surfaces
      the Phase-4 deposit as a signing request with correct fields.
- [ ] **5.3 Kill the websocket response path in the server** — responses go to
      the signature-responses contract (Phase 6). Keep tx building/signing.

## Phase 6 — signature-responses contract

- [ ] **6.1 Design the response record with the library patterns:** module (or
      extension) in signet-midnight defining `SignetSignatureResponse`
      (outputData or its hash, Schnorr signature components, responder) and a
      field-0 `Map<SignetRequestId, SignetSignatureResponse>` index — same
      conventions as requests: TS twins, state-reader, tripwire tests.
- [ ] **6.2 Implement `signature-responses.compact`:** MPC-gated `respond`
      circuit (pinned MPC key hash from constructor), dedup per requestId.
      Simulator tests.
- [ ] **6.3 Response poller in signet-midnight** (`response-poller.ts` per the
      package README plan): poll the responses contract by requestId via the
      state reader. No websockets — repo-wide rule.
- [ ] **6.4 Deploy** via the Phase-2 tool; manifest entry; extend the monitor
      to POST responses to this contract (Midnight tx from the MPC identity).

## Phase 7 — Integration orchestration (response half)

- [ ] **7.1 Extend the integration suite:** deposit → monitor (or a scripted
      MPC simulator, port `mpc-simulator.ts` from the old contract-cli) signs
      and posts the response → poller sees it.
      *Done when:* request→response round-trip runs green against the local
      stack without manual steps.

## Phase 8 — Port claim

- [ ] **8.1 Port the `schnorr` module** (old `schnorr.compact`, Jubjub
      verify polyfill) into signet-midnight as a second shared Compact module
      + its TS signing helpers (`schnorr.ts` derive/sign/challenge) for the
      simulator MPC. Unit-test sign→verify through compiled circuits.
- [ ] **8.2 Vault config: add `mpcPubKeyHash`** (sealed, constructor arg —
      completes the MVP constructor). Update deploy tooling + manifest.
- [ ] **8.3 Port `claim`:** verify MPC key + Schnorr over (requestId,
      hash(outputData)), verify caller identity against the stored request's
      path (single `lookup` replaces the MVP's per-field reads), mint shielded
      tokens, remove the request (one `remove` replaces 19).
      *Done when:* simulator test passes deposit→simulated-response→claim;
      double-claim and wrong-identity rejected; measure rows vs MVP's 438,548.
- [ ] **8.4 Claim integration test** on the local stack (response read from
      the responses contract, not passed by hand).

## Phase 9 — Port withdraw + completeWithdraw

- [ ] **9.1 Port `withdraw`:** token-color check, coin escrow via `heldCoin` +
      `receiveShielded`/`writeCoin`, `kernel.checkpoint()` ordering (validate
      → take coin → fallible writes), `refundRecipient`, vault-path request
      (`path = "vault"` — note: NOT identity-bound; decide how that path is
      authorized in the new layout and document it).
- [ ] **9.2 Port `completeWithdraw`:** Schnorr verify, success-byte check,
      refund mint to pinned recipient on failure, cleanup.
- [ ] **9.3 Simulator + integration tests** for the full withdraw lifecycle
      (success and refund branches).

## Phase 10 — End-to-end + hardening

- [ ] **10.1 Full e2e run** (local stack or Sepolia per a new runbook ported
      from `docs/e2e-sepolia-runbook.md`): deposit → sign → EVM broadcast →
      respond → claim; withdraw → refund path. Document as `docs/runbook.md`.
- [ ] **10.2 CI:** workflow running compile → build → test on every push
      (skip-zk; zk compile weekly/manual — it's the row-count canary).
- [ ] **10.3 Hardening backlog** (pull forward as needed):
      - caip2Id ↔ chainId consistency (unchecked in MVP and now; the MPC
        routes by caip2Id but signs chainId — decide where it's enforced).
      - TS branding for `SignetRequestId` (nominal on the Compact side only).
      - JSDoc sweep of pre-rule packages (lib, deploy) as they get ported.
      - Revisit `Vector<4>` / generic `<#N>` calldata only if a concrete
        contract hits the cap.
- [ ] **10.4 Docs finish:** README architecture section, module-header links
      verified, `repo-layout.md` in the old repo marked superseded.

---

**Sequencing notes**

- 1.4 (field right-sizing) is the only task that breaks stored-data
  compatibility — do it BEFORE Phase 3's first persistent deployment, or
  accept a redeploy.
- Phases 5 and 6 can proceed in parallel with 4 (different repos/packages);
  7 needs both.
- Keep the deployment manifest (2.3) authoritative from its first existence —
  every later phase keys off it.
