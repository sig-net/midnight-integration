# Refactor task list — midnight-erc20-vault

**How to use this file (read this first, agent):** This is the single source
of truth for the refactor. It contains all context needed to execute any task
without prior conversation history. Work ONE task at a time ("execute 1.1").
When you finish a task: tick its checkbox, append the commit hash to the task
line, and record any decision you made in the **Decision Log** at the bottom
(template there). If you deviate from a task's description, say why in the
log. Run `npm run compile && npm run build && npm run test` from the repo root
before calling anything done. Read `/AGENTS.md` and the member `AGENTS.md` of
any package you touch — the rules there (JSDoc on all exports, latest deps,
no emitted JS, simulator-only unit tests, websocket ban) are non-negotiable.

---

# Part 1 — Context a new agent needs

## What this project is

A **bit-by-bit rewrite** of a working MVP that demonstrates sig-net (signet)
cross-chain interactions from Midnight: an ERC20 vault on an EVM chain driven
by MPC-signed EVM transactions requested from a Midnight Compact contract.
The rewrite's goals: reusable signet plumbing extracted into ONE library
package, clean separation of app-specific vs protocol args, generated types
instead of hand-maintained deserialization, and a repo layout that could seed
a future signet.js Midnight adapter.

## The protocol in one paragraph

A "signet contract" on Midnight records **signature requests** ("please sign
this EVM transaction") in its public ledger. The sig-net **MPC network** needs
only the contract address: it polls raw contract state via the Midnight
indexer, finds the request index at **ledger field 0** (layout convention),
decodes each request, re-assembles + RLP-encodes the EVM transaction, signs it
with a key **derived from (contract address, path)** (epsilon derivation — the
`path` string determines WHICH derived key), and broadcasts. After EVM
execution it Schnorr-signs `(requestId, outputData)` and posts the response to
a **signature-responses contract** on Midnight (the old websocket push is
banned repo-wide). The user's wallet polls that contract and calls `claim` on
the vault, which verifies the Schnorr signature in-circuit and mints shielded
tokens. Deposit moves ERC20 → vault (tx sent from the USER's derived address);
withdraw moves vault → user (tx from the VAULT's derived address, `path =
"vault"`, with a coin-escrow + refund-on-failure model).

**Identity model:** users prove identity via a secret-key witness
(`callerSecretKey`); only `userCommitment(sk) = persistentHash(["vault:user:",
sk])` reaches the ledger. The commitment doubles as the MPC derivation path:
`path` MUST be the canonical lowercase hex of the caller's commitment,
zero-padded. The contract cannot hex-ENCODE in-circuit (no div/mod in the
prime field) but can VERIFY a hex decoding (multiply/add/compare) — so the
caller supplies the hex and `assertPathCommitment` verifies it. This forces a
1:1 identity→path→derived-EVM-account mapping and lets the MPC treat `path`
as an opaque string (no Midnight special case).

## Repo map (local checkouts)

| Path | What it is |
|---|---|
| `~/Projects/github.com/sig-net/midnight-erc20-vault-refactor` | THIS repo. Branch `bernard/repo-refactor`, remote `sig-net/midnight-erc20-vault` |
| `~/Projects/github.com/sig-net/midnight-erc20-vault` | Old checkout holding the **MVP** (reference implementation, do not modify) |
| `~/Projects/github.com/sig-net/mpc` | MPC node + chain contracts. Canonical request shape: `chain-signatures/primitives/src/bidirectional.rs` (`SignBidirectionalEvent`); Solana entrypoint `chain-signatures/contract-sol/src/lib.rs`; request-id hashing `chain-signatures/indexer-core/src/utils/hashing.rs` |
| `~/Projects/github.com/sig-net/solana-signet-program` | Response server. `clients/response-server/src/modules/MidnightMonitor.ts` is the OLD monitor (fixed-index reader, to be rewritten in Phase 5) |

Key MVP files (old checkout):
- Contract: `boilerplate/contract/src/erc20-vault.compact` — deposit ~L173-270,
  withdraw ~L281-375, claim ~L387-480, completeWithdraw ~L483-561, hex helpers
  ~L74-99, 18-field request-id ~L122-165, constructor/initialize ~L101-115.
- Schnorr module: `boilerplate/contract/src/schnorr.compact` (Jubjub verify
  polyfill, used via `import "./schnorr" prefix Schnorr_;`).
- Off-chain signet plumbing: `boilerplate/contract-cli/src/signet/`
  (request-id, calldata-builder, tx-builder, codec, constants, schnorr,
  state-reader) — audit against signet.js before porting anything; only what
  signet.js lacks comes across.
- MPC simulator for tests: `boilerplate/contract-cli/src/test/mpc-simulator.ts`.
- E2E reference: `docs/e2e-sepolia-runbook.md`, `src/test/vault.e2e.test.ts`.

## Package map (this repo)

| Package | Role | State |
|---|---|---|
| `packages/signet-midnight` | THE library: shared Compact module(s) + TS twins + raw state reader + compiled pure circuits. Seed of a signet.js Midnight adapter. Chain plumbing only, nothing vault-specific | Phase 0 done |
| `packages/vault-contract` | The ERC20 vault Compact contract + witnesses + simulator tests + deploy entry | deposit + config ported |
| `packages/signature-responses-contract` | Contract the MPC posts `(requestId → response)` to; watchers poll it | placeholder stub |
| `packages/deploy` | Generic deployer. `src/deploy.ts` has the typed skeleton; port `buildDeployTransaction` from midday `app/ui/lib/actions/buildDeployTransaction.ts` (see its README) | stub, deps installed |
| `packages/lib` | Shared runtime plumbing (config/providers/wallet/logging) — the ONLY copy | stub |
| `packages/cli` | Example client CLI: the reference orchestration a UI would implement (read state, initialize, deposit/withdraw E2E via polled responses). Integration tests drive the vault THROUGH it | skeleton scaffolded; commands stubbed with NotImplementedError |
| `packages/integration-tests` | Anything needing a running stack: the ordered e2e pipeline (env check → compile/deploy → key/address derivation → MPC hand-off printout → initialize → deposit preflight) driving the vault through the cli | scaffolded, pipeline through initialize working |

Key library files (all in `packages/signet-midnight/src/`), which MUST stay in
lockstep — field order and widths are the wire format:
1. `SignetRequests.compact` — the Compact module (structs, id hash, path
   binding, request construction). Module-only file: it may contain ONLY the
   `module` + comments, or external `import` of it breaks.
2. `signet-requests.ts` — hand-written TS twins of the structs (documented).
3. `state-reader.ts` — hand-composed compact-runtime descriptors + raw state
   walk (`readSignetEVMSignatureRequestIndexFromState`). This is what the MPC
   monitor will use: decode by field position, no compiled contract.
4. `circuits.compact` — contract-less program re-exporting the module's pure
   circuits so they compile to `managed/contract/index.js` `pureCircuits`.
5. `tests/circuits.test.ts` + `tests/state-reader.test.ts` — behavior tests
   AND type tripwires: they annotate generated values with the twin types, so
   drift breaks `npm run build`, not runtime.

## Commands

```
npm install                      # repo root ONLY, never inside a member
npm run compile                  # all packages with a compile script (--skip-zk)
npm run compile:vault            # one package (also :responses, :signet)
npm run compile:vault:zk         # with proving keys (slow; prints k/rows)
npm run build                    # tsc --noEmit everywhere; REQUIRES compile first
npm run test                     # vitest everywhere (simulator-only)
```

Toolchain: `compact` CLI, unpinned (currently 0.31.1; binary at
`~/.compact/versions/<v>/aarch64-darwin/compactc`). Language pragma `>= 0.22`.
The vault's compile script sets `COMPACT_PATH=../../node_modules` so the
contract can `import "@midnight-erc20-vault/signet-midnight/src/SignetRequests"`
exactly like a consumer of the published package would (npm workspaces symlink
it into root node_modules). `src/managed/` is generated output — gitignored,
never committed, regenerate with compile.

## Measured baselines (compactc 0.31.1, k = log2 rows domain)

| Circuit | MVP rows | Refactor rows |
|---|---|---|
| requestDeposit (MVP `deposit`, renamed per D13) | k=19, 454,021 | k=19, **419,499** (whole-struct hash is CHEAPER than MVP's 18-field scheme) |
| initialize | k=13, 4,344 | k=13, 4,344 |
| claim | k=19, 438,548 | not ported yet — this is the target baseline |
| completeWithdraw | k=18, 261,967 | not ported |
| withdraw | k=17, 130,568 | not ported |

Cost model: deposit is HASH-dominated (`persistentHash` over the ~1.9KB
request struct). ~75% of hashed bytes are zero padding in oversized fields —
see task 1.4. Ledger reads/writes and comparisons are noise by comparison.

## Gotchas that already cost debugging time (do not rediscover)

- **All exported-circuit arguments are PRIVATE inputs.** Anything written to
  the ledger must be wrapped in `disclose(...)` at the write site or the
  compiler rejects with witness-disclosure errors.
- **`Map` cannot be a struct field.** Structs take ordinary value types only;
  `Map` is a ledger-state (ADT) type. Error appears only when the struct is
  USED (dead struct declarations pass silently). Fixed-capacity `Vector` is
  the price of an atomic single-record request — there is no "pay only for
  what you use" in a ZK circuit (fixed shape; `Maybe<T>` occupies full width
  even when none).
- **`fromValue` consumes its input.** Always hand descriptors a copy:
  `desc.fromValue([...cell.value])`.
- **Struct field order/widths = wire format.** A reorder in
  `SignetRequests.compact` without the same change in `signet-requests.ts` +
  `state-reader.ts` is silent data corruption. The tripwire tests catch shape
  drift at build time but NOT order swaps between same-typed fields.
- **The compiler emits NO named TS types** — struct shapes are inlined
  anonymously in `managed/contract/index.d.ts`. The named types live in
  `signet-requests.ts` by hand, verified structurally by the tripwires.
- **`persistentHash` vs `transientHash`:** request ids persist on the ledger
  and are recomputed off-chain across time → MUST be `persistentHash`.
- **Off-chain id computation:** never re-implement the hash in TS. Call
  `pureCircuits.signetEVMSignatureRequestId(...)` from signet-midnight — the
  compiled circuit IS the reference implementation.
- **Compact module import resolution:** relative to the importing file first,
  then each dir in `COMPACT_PATH`. Module file must contain only the module.
- **compactc output is block-buffered when piped** — use `script -q` (pty) if
  you need to stream k/rows lines from a background zk compile.

## Decisions already made (rationale in Decision Log, bottom of file)

D1 single-map request index (field 0) replacing MVP's 21 parallel maps ·
D2 request id = domain-separated `persistentHash` of the WHOLE record ·
D3 `SignetRequestId` is chain-agnostic; EVM-prefix only on structs that encode
EVM concepts · D4 calldata is contract-built, NEVER caller-supplied ·
D5 `Vector<4>` calldata args · D6 `evmValue` stays in the struct ·
D7 node_modules-style Compact imports via COMPACT_PATH · D8 signet-midnight
compiles pure circuits, skip-zk only (no compile:zk script on purpose) ·
D9 responses flow through a contract, polled — websocket path is dead ·
D10 `outputData` (response-side) is NOT in the request record.

---

# Part 2 — Task list

Each task has a **Done when** — don't move on until it holds.

## Phase 0 — Library abstraction ✅ done (commits `f6b077f` and earlier)

- [x] `SignetRequests.compact` shared module: request structs (EVM tx /
      calldata / MPC routing), nominal `SignetRequestId`, domain-separated
      whole-struct request-id hash, path↔identity binding circuits.
- [x] TS twins + MPC-style raw `state-reader.ts`, tripwire tests both sides.
- [x] Compiled pure circuits (`circuits.compact`, skip-zk) as the executable
      reference implementation.
- [x] Vault `deposit` ported in full + deployer-gated `initialize` config.
- [x] Measured: deposit k=19 rows=419,499 (MVP: 454,021) — no regression.

## Phase 1 — Finish the deposit flow (simulator level)

- [x] **1.1 Export `userCommitment` for off-chain use.** ✅ `316e905` It is vault-specific
      (domain tag `"vault:user:"`), so it does NOT move into SignetRequests.
      Add `export` to the `userCommitment` circuit in
      `packages/vault-contract/src/erc20-vault.compact` so it lands in the
      vault's generated `pureCircuits`, and re-check `src/index.ts` re-exports
      the managed output (it does). TS can then compute deployer/caller
      commitments without re-porting the hash.
      *Done when:* a vault test calls `pureCircuits.userCommitment(sk)` and
      uses it to build a valid `path` (hex via `requestIdHex` from
      signet-midnight, zero-padded to 256).
- [x] **1.2 Deposit round-trip simulator test.** ✅ `316e905` In
      `packages/vault-contract/tests/contract.test.ts`: initialize the
      contract (deployer commitment from 1.1), call `deposit` through the
      simulator (`contract.circuits.deposit(ctx, signetParams,
      depositRequest)`, threading `result.context`), then assert the SAME
      record comes back three ways: generated `ledger()` read, shared
      `toSignetEVMSignatureRequestIndex`, and raw
      `readSignetEVMSignatureRequestIndexFromState` on
      `ctx.currentQueryContext.state`. Raw reader has only ever seen synthetic
      trees — this closes the last decode-correctness gap.
      *Done when:* all three reads deep-equal the input; the map key equals
      `pureCircuits.signetEVMSignatureRequestId(record)` (signet-midnight).
- [x] **1.3 Validation + gating tests.** ✅ `316e905` initialize: deployer-gated (wrong sk
      rejected), one-shot (second call rejected). deposit: rejects when
      uninitialized, zero erc20 address, zero amount, amount > Uint<64> max,
      `to != erc20Address`, nonzero `value`, zero chainId/gasLimit, duplicate
      request (same params twice WITHOUT nonce bump — note requestNonce is in
      the hash, so an identical resubmission after increment is a NEW id; test
      the actual dedup semantics), wrong-identity path (hex of a different
      commitment).
      *Done when:* each assert in deposit/initialize has a test tripping it.
- [ ] **1.4 Protocol-freeze pass on the request layout.** ⏸ DEFERRED — see
      D11: field right-sizing deviates from the request structure used on
      other signet chains; needs MPC-team sign-off first. The ⚠️ below still
      applies: do this (or explicitly accept a redeploy) before Phase 3's
      first persistent deployment. ⚠️ LAST chance
      before persistent deployments — this changes stored bytes AND ids.
      Right-size the padded fields in `SignetRequests.compact`: `path` 256→64
      (it IS exactly the 64-char hex; the zero-pad assert then disappears),
      `funcSig` 256→64, `caip2Id`/`dest` 64→32, honest maxima for `params` and
      the two schemas (check what the MVP e2e actually stored — see
      `contract-cli/src/signet/constants.ts` and the runbook). Update the TS
      twins + state-reader descriptors + all fixtures IN THE SAME CHANGE.
      Re-measure deposit with `npm run compile:zk vault-contract` (expect
      ~419K → ~150-250K rows). Record new widths + rows in the Decision Log.
      *Done when:* widths are deliberate and recorded; compile/build/test
      green; new row count logged below.

## Phase 2 — Deploy tooling

- [x] **2.1 Port `buildDeployTransaction`** — DIRECTION CHANGE: the generic
      `packages/deploy` package was dropped (constructors grew args —
      `deployerCommitment: Uint8Array` — which a generic deployer can only
      take untyped, forcing dynamic module loading + witness stubs). Instead
      the midday port lives in `packages/lib/src/deploy.ts`
      (`makeCompiledContract` + `buildDeployTransaction`, generic over
      `<C, PS>` so constructor args stay statically typed) and
      `packages/lib/src/wallet.ts` (`submitUnprovenTransaction`,
      `withSyncedWalletFacade`, from midday `SeedWallet.ts`). Each contract
      package's `deploy.ts` statically imports its own generated module and
      passes its real witnesses — no stubs, no `contract-info.json` parsing.
      ✅ *Done:* `tests/deploy.test.ts` in both contract packages builds a
      deploy tx from the real managed output (skips cleanly, with a visible
      reason, when `src/managed/keys/` is absent — run `compile:zk` first).
- [ ] **2.2 Port wallet/provider plumbing into `packages/lib`** from the old
      repo's contract-cli (typed env config, indexer/node/proof-server
      providers, wallet build/restore, logging). ONE copy; contract deploy
      scripts + integration-tests consume it. JSDoc everything (AGENTS rule).
      Partially done via 2.1 (deploy config, facade lifecycle, unproven-tx
      submission); still open: providers, logging.
      *Done when:* lib exposes typed config + provider builders; no
      per-package copies anywhere.
- [ ] **2.3 Vault `deploy.ts`** (`packages/vault-contract/deploy.ts`, run via
      `npm run deploy -w @midnight-erc20-vault/vault-contract`): compile:zk →
      build deploy tx (deployer commitment via `pureCircuits.userCommitment`)
      → sign/prove/submit via lib wallet ✅ (done via 2.1's rewrite; deployer
      identity = `VAULT_DEPLOYER_SECRET_KEY`, falling back to the
      `DEPLOYER_SEED` bytes) → still open: call `initialize(vaultEvmAddress)`
      → write a **deployment manifest** `deployments/<network>.json`:
      { contractAddress, constructorArgs, contractSourceHash (hash of the
      .compact source + compiler version), deployedAt, initialized }.
      The manifest is what lets every later stage SKIP redeploying.
      *Done when:* deploy against a local stack produces a manifest and an
      initialized contract.

## Phase 3 — Local stack + deployment verification

- [ ] **3.1 Local Midnight stack script** (docker compose: node, indexer,
      proof server — check the old repo/runbook and midnight-js examples for
      a compose file to port; put it in root `scripts/` or `packages/lib`).
      Include a health-check that waits for all three endpoints.
      *Done when:* one command brings the stack up healthy from scratch.
- [ ] **3.2 Deploy vault to local stack and verify from the outside.** Query
      the deployed address via the indexer with NO compiled contract:
      `readSignetEVMSignatureRequestIndexFromState(contractState.data)` sees
      an empty map at field 0; the counter at field 1 reads 0. (Provider:
      `indexerPublicDataProvider(...).queryContractState(address)` — see the
      old MidnightMonitor for usage.)
      *Done when:* a script/test proves the MPC-convention read works against
      a real indexer, not just the simulator.

## Phase 4 — CLI client + integration-test orchestration (deposit half)

`packages/cli` (scaffolded: commander command surface, config/identity wiring
via lib, every network boundary a NotImplementedError stub) is the example
client — the reference orchestration a UI would implement. Integration tests
drive the vault THROUGH its exported command functions; tests consume the
CLI, never the reverse. Its README documents the command surface and both
E2E flows.

- [x] **4.1 Rename vault circuits to the client-facing names (D13).** ✅ `59b3276`
      `deposit` → `requestDeposit` in
      `packages/vault-contract/src/erc20-vault.compact` + all TS/test
      references. Future ports land directly under the new names: MVP
      `claim` → `claimDeposit` (Phase 8), MVP `withdraw` → `requestWithdraw`,
      MVP `completeWithdraw` → `refundWithdraw` (Phase 9). Circuit names are
      part of the generated API and the call-tx key location, so rename
      before any persistent deployment.
      *Done when:* compile/build/test green; baselines table row renamed.
- [x] **4.2 midnight-js provider plumbing (D14)** (closes the "providers"
      half of 2.2). ✅ `4a8d7dc` Verified against a live local stack via the
      integration suite (task 4.4): the initialize step ran the cli's
      `initialize` (real callTx through the proof server, finalized on
      chain) and `readState`, and the ledger read back `initialized: 1`
      with the sealed EVM address. What landed, and where (D14 amendment —
      providers are CONTRACT-package concerns, not lib):
      - lib `src/midnight-providers.ts`: `createWalletAndMidnightProvider(
        facade, keys)` — the generic WalletFacade →
        WalletProvider/MidnightProvider adapter (`balanceTx` =
        balanceUnboundTransaction → signRecipe → finalizeRecipe; `submitTx` =
        facade.submitTransaction; `as never` casts bridge
        midnight-js-protocol vs ledger-v8 nominal identities).
      - vault-contract `src/providers.ts`: `buildVaultProviders(facade,
        keys, config)` → `VaultProviders` (= `MidnightProviders<
        VaultCircuitId, VaultPrivateStateId, VaultPrivateState>`), plus
        `vaultCompiledContract` and `VAULT_PRIVATE_STATE_ID` — the vault
        package IS the SDK a client consumes. Provider deps installed there
        at 4.1.1 (= latest, matches lib's midnight-js).
      - cli: `createCliContext(config, {facade, keys})` (`src/context.ts`)
        joins the vault; `CliContext` = { config, providers, vault }.
        main.ts owns the lifecycle linearly: parse (offline) → derive keys →
        `withSyncedWalletFacade` → createCliContext → run the selected
        command. `setNetworkId` (midnight-js process-global) is called in
        createCliContext.
      *Done when:* `initialize` and `read-state` execute against the local
      stack (Phase 3.1) — the code paths exist end-to-end but have never
      touched a running node/indexer/proof server.
- [ ] **4.3 Wire the remaining CLI commands** (the command logic already
      exists; replace the remaining NotImplementedError boundaries):
      `request-deposit` needs the MPC routing constants + codec ported from
      the MVP (`contract-cli/src/signet/constants.ts`) to construct the
      signet request arguments, then recompute the id via
      `pureCircuits.signetEVMSignatureRequestId` + `requestIdHex`, assert it
      equals the ledger map key, print it; `poll-response` against the
      placeholder record; `broadcast-evm` (add `ethers` to the cli package
      then).
      *Done when:* request-deposit lands a request on the local stack and
      read-state decodes it back with a matching id.
- [x] **4.4 Scaffold `packages/integration-tests`** (vitest; env-gated so the
      suite SKIPS cleanly when no stack is configured — AGENTS.md forbids
      network access in unit tests, this package is the sanctioned home).
      Tests import the CLI's exported command functions.
      ✅ `4a8d7dc` (see D15–D17): one ordered `tests/e2e.test.ts` pipeline gated on
      `RUN_INTEGRATION_TESTS` (root `npm run test:integration` sets it,
      `--bail 1`); env accumulator seeded from repo-root `.env` +
      process.env; setup steps skip-if-set so a populated `.env` reuses the
      first run's deployment (a manual precursor of 4.5). Pulled forward
      along the way: root `docker-compose.yaml` + `standalone.env.example`
      (most of 3.1 — `docker compose up -d --wait` is the one command; no
      separate wait script needed, healthchecks are in the compose),
      signet-midnight ports (`deriveEvmAddress` epsilon v1.0.0, D16;
      `deriveJubjubKeypair`; `deriveMpcKeys`; `generateMpcRootKey` — all
      golden-vector-tested against the MVP implementations), and
      `deployVault(env)` exported from vault-contract (deploy.ts is now a
      thin shell) so the suite deploys in-process.
- [ ] **4.5 "Ensure deployed" helper — deploy once, reuse forever.** Reads the
      manifest; verifies the address still answers (indexer query + field-0
      shape + contractSourceHash match); deploys fresh only if missing/stale.
      *Done when:* second run of the suite reuses the first run's contract.
- [ ] **4.6 Deposit integration test:** drive the CLI's `requestDeposit` and
      `readState` functions against real providers/wallet — the CLI builds
      the path, submits, and verifies the id; the test asserts on the
      results and never re-implements the orchestration.
      *Done when:* a deposit lands on a real chain and the MPC-style read
      returns exactly what was submitted.

## Phase 5 — Response server (cross-repo: solana-signet-program)

- [ ] **5.1 Decide how the response server consumes signet-midnight** (npm
      publish vs `file:` dep vs vendored copy). Record in the Decision Log
      here AND in that repo.
- [ ] **5.2 Rewrite `MidnightMonitor`** (`clients/response-server/src/modules/
      MidnightMonitor.ts`) for the new layout: poll the field-1 counter for
      cheap change detection; read field 0 via the shared state reader; verify
      each record's map key by recomputing the id with the compiled circuits;
      DELETE the fixed-index `IDX` table, compound-key calldata logic, and all
      `managed/erc20-vault/signet/*` imports it currently uses.
      *Done when:* the monitor pointed at the Phase-3 deployment surfaces the
      Phase-4 deposit as a signing request with correct decoded fields.
- [ ] **5.3 Kill the websocket response push in the server** — responses go to
      the signature-responses contract (Phase 6). Keep EVM tx build/sign.

## Phase 6 — signature-responses contract

- [ ] **6.1 Design the response record with the library patterns:** a module
      (in signet-midnight, e.g. `SignetResponses.compact`) defining
      `SignetSignatureResponse` (outputData — or its hash + the data in a
      wider field, decide and log — Schnorr signature components
      (announcement point, response scalar, pk), responder) and a field-0
      `Map<SignetRequestId, SignetSignatureResponse>` index. Same conventions
      as requests: TS twins + state-reader descriptors + tripwire tests.
- [ ] **6.2 Implement `signature-responses.compact`** (replace the
      placeholder): constructor pins the MPC key hash; `respond` circuit gated
      to the MPC identity; dedup per requestId. Simulator tests.
- [ ] **6.3 Response poller in signet-midnight** (`response-poller.ts` per the
      package README plan): poll the responses contract by requestId via the
      state reader. NO websockets.
- [ ] **6.4 Deploy** via the Phase-2 tool; manifest entry; extend the monitor
      to submit responses as Midnight transactions from the MPC identity.

## Phase 7 — Integration orchestration (response half)

- [ ] **7.1 Extend the integration suite:** deposit via the CLI → monitor (or
      a scripted MPC simulator — port
      `boilerplate/contract-cli/src/test/mpc-simulator.ts`) signs and posts
      the response to the responses contract → the CLI's `pollResponse` (not
      a bespoke test poller) picks it up.
      *Done when:* request→response round-trip runs green against the local
      stack without manual steps.

## Phase 8 — Port claim

- [ ] **8.1 Port the `schnorr` module** (old `schnorr.compact` — Jubjub
      Schnorr verify polyfill, temporary until CompactStandardLibrary ships
      `jubjubSchnorrVerify`) into signet-midnight as a second shared module,
      plus its TS helpers (derive/sign/challenge from
      `contract-cli/src/signet/schnorr.ts` + response-server copy) for the
      simulator MPC. Export via `circuits.compact` where pure. Unit-test
      sign→verify through compiled circuits.
- [ ] **8.2 Vault config: add `mpcPubKeyHash`** (sealed, constructor arg —
      completes the MVP constructor: `persistentHash<JubjubPoint>(mpcPk)`).
      Update deploy tooling + manifest + tests.
- [ ] **8.3 Port `claim` as `claimDeposit`** (D13; MVP ~L387-480): pk-hash
      check, ERC20 return-value check, Schnorr verify over (requestId,
      hash(outputData)) as 16-byte field limbs, caller identity vs the stored
      request's path — a single `signetRequestsIndex.lookup(rid)` replaces
      the MVP's per-field reads — mint shielded tokens (domain separator
      binds erc20 + contract address; mint nonce binds requestId), then ONE
      `remove` replaces the MVP's 19. Coin handling on the client side is
      free: midnight-js `callTx` balances the mint's offer like any call
      (D14) — verify it, don't build it.
      *Done when:* simulator test passes deposit→simulated-response→claim;
      double-claim + wrong identity rejected; rows measured vs MVP's 438,548
      and logged.
- [ ] **8.4 Claim integration test** on the local stack: wire the CLI's
      `claim-deposit` command (replacing its NotImplementedError stub) and
      drive it from the suite (response read from the responses contract,
      not passed by hand). `deposit-e2e` now runs start to finish.

## Phase 9 — Port withdraw + completeWithdraw

- [ ] **9.1 Port `withdraw` as `requestWithdraw`** (D13; MVP ~L281-375): token-color check
      (`tokenType(domainSep, kernel.self())`), coin escrow (`receiveShielded`
      + `heldCoin.writeCoin`), `kernel.checkpoint()` ordering (validate → take
      coin → fallible-but-pure writes so the coin can't strand),
      `refundRecipient` map. ⚠️ Design decision to make and log: MVP's
      withdraw uses `path = "vault"` (NOT identity-bound) — decide how the
      vault-path request is authorized/represented with
      `constructSignetEVMSignatureRequest`, which currently ALWAYS enforces
      the identity binding (likely: a second construct variant or an
      explicit vault-path circuit in the vault itself).
- [ ] **9.2 Port `completeWithdraw` as `refundWithdraw`** (D13; MVP
      ~L483-561): Schnorr verify, success = first output byte == 0x01
      (one-byte check avoids BLS overflow of a 32-byte cast), refund mint to
      the pinned recipient on failure, permissionless caller, cleanup.
      (The name covers both branches: success finalizes, failure refunds.)
- [ ] **9.3 Simulator + integration tests** for the full withdraw lifecycle
      (success and refund branches). Wire the CLI's `request-withdraw`,
      `refund-withdraw`, and `withdraw-e2e` stubs; the suite drives them.

## Phase 10 — End-to-end + hardening

- [ ] **10.1 Full e2e run** (local stack or Sepolia per a new runbook ported
      from the MVP's `docs/e2e-sepolia-runbook.md`), driven by the CLI's
      `deposit-e2e` and `withdraw-e2e` commands: request → sign → EVM
      broadcast → respond → claim/settle, refund branch included. Document
      as `docs/runbook.md`.
- [ ] **10.2 CI:** compile → build → test on every push (skip-zk); zk compile
      as a weekly/manual job — it is the row-count canary (compare against the
      baselines table above).
- [ ] **10.3 Hardening backlog** (pull forward as needed):
      - caip2Id ↔ chainId consistency: unchecked in MVP and now; the MPC
        routes by caip2Id but the signed tx pins chainId. Decide where it is
        enforced (contract assert vs monitor refusal) and log it.
      - TS branding for `SignetRequestId` (nominal only on the Compact side).
      - JSDoc sweep of pre-rule code as lib/deploy get ported.
      - `Vector<4>` → generic `EVMCalldata<#N>` ONLY if a concrete contract
        hits the cap (Compact supports generic structs/circuits; genericity
        infects the request struct + index + circuits, so don't pay early).
      - Heavyweight-circuit note: deposit/claim are k≈19; fine for vault UX,
        wrong base for any future lightweight request — that would be a new
        smaller request variant, not a tweak.
- [ ] **10.4 Docs finish:** README architecture section, module-header links
      verified, `repo-layout.md` in the old repo marked superseded.

**Sequencing notes**

- 1.4 is the only task that breaks stored-data compatibility — do it BEFORE
  Phase 3's first persistent deployment, or accept a redeploy.
- The CLI wiring (4.3) precedes the integration suite (4.4+) — tests consume
  the CLI, never the reverse.
- Phases 5 and 6 can proceed in parallel with 4 (different repos/packages);
  7 needs both.
- Keep the deployment manifest (2.3) authoritative from its first existence.

---

# Part 3 — Decision Log

Append-only. Newest at the bottom. Template:

```
### D<n> — <title> (<date>, task <id>)
**Decision:** …
**Why:** …
**Alternatives rejected:** …
**Impact:** files/protocol affected; migration cost if reversed.
```

### D1 — Single-map request index at ledger field 0 (2026-07, Phase 0)
**Decision:** One `Map<SignetRequestId, SignetEVMSignatureRequest>` as the
contract's FIRST ledger field, replacing the MVP's 21 parallel maps + fixed
field indices 0-21.
**Why:** Atomic records (no partial-write states), one dedup/cleanup point,
MPC reads "field 0 → decode struct" instead of a 21-entry index table with
compound-key calldata. Measured: fewer rows than the MVP despite hashing the
whole record.
**Impact:** The MPC monitor must be rewritten (Phase 5). "Field 0" is now a
cross-repo protocol convention.

### D2 — Request id = domain-separated hash of the whole record (2026-07)
**Decision:** `id = persistentHash([pad(32,"signet:evm:request:"),
persistentHash<SignetEVMSignatureRequest>(request)]) as SignetRequestId`,
computed by `signetEVMSignatureRequestId`.
**Why:** Id commits to EVERY field (MVP's hash bound only a commitment of the
args); nothing to hand-maintain when fields change; measured cheaper than the
MVP's 18-field scheme (419,499 vs 454,021 rows). Domain tag partitions the id
space per request kind for future chains.
**Alternatives rejected:** porting the MVP 18-field hash (compat argument
moot — the layout change already breaks the old monitor).
**Impact:** Off-chain id computation MUST call the compiled circuit. Any
struct change changes all ids (fine pre-deployment; see task 1.4).

### D3 — SignetRequestId is chain-agnostic (2026-07)
**Decision:** Keep the id type unprefixed; EVM prefix only on structs that
structurally encode EVM concepts (EVMTransactionParams, EVMCalldata,
SignetEVMSignatureRequest*).
**Why:** Downstream consumers (responses contract, pollers, MPC) treat ids as
opaque 32-byte keys; per-chain id types would infect all of them for zero
information. Future chains add their own request struct + id circuit + domain
tag; id type, responses contract, poller unchanged.

### D4 — Calldata is contract-built, never caller-supplied (2026-07)
**Decision:** `SignetEVMSignatureRequestParams` (caller-supplied) deliberately
excludes calldata; contracts assemble `EVMCalldata` in-circuit and pass it to
`constructSignetEVMSignatureRequest`.
**Why:** This is the "malicious client cannot get arbitrary calls signed"
invariant, expressed in the type system.

### D5 — Vector<4> calldata args (2026-07)
**Decision:** Fixed 4 ABI-word slots + argCount.
**Why:** `Map` in a struct is impossible (compiler: "expected ordinary Compact
type but received ADT type"); circuits are fixed-shape so "up to 99, pay for
3" cannot exist (`Maybe` occupies full width). 4 covers the token-primitive
category (transfer 2, transferFrom 3, ERC-4626 withdraw 3, Aave supply 4);
calls beyond that also need dynamic ABI types the flat-words model can't
express anyway.
**Impact:** Capacity is a protocol constant; changing it changes ids (bump
domain tag). Escape hatch if ever needed: generic `EVMCalldata<#N>`.

### D6 — evmValue stays in the shared struct (2026-07)
**Decision:** Keep `value` in EVMTransactionParams; the vault asserts
`value == 0` as app-level validation.
**Why:** The struct is a faithful EIP-1559 param set for ANY contract.

### D7 — node_modules-style Compact imports (2026-07)
**Decision:** Contracts import
`"@midnight-erc20-vault/signet-midnight/src/SignetRequests"` resolved via
`COMPACT_PATH=../../node_modules` in the compile script; signet-midnight ships
`src/` via package.json `files`.
**Why:** Byte-identical to what a real `npm install` of the published package
gives consumers (OpenZeppelin Compact uses the same pattern). Compiler ignores
package.json `exports` — plain filesystem resolution.

### D8 — signet-midnight compiles pure circuits, skip-zk only (2026-07)
**Decision:** `circuits.compact` (contract-less program) re-exports the
module's pure circuits; `compile` script with `--skip-zk`; deliberately NO
`compile:zk` script so the root zk fan-out (`--if-present`) skips it.
**Why:** Pure circuits run in TS without keys; gives unit tests + an
executable reference implementation. Compiler emits no named TS types
(structs inline anonymously), so the hand-written twins + tripwire tests are
the type story.

### D9 — Responses via contract, polled (inherited from repo design)
**Decision:** MPC posts responses to the signature-responses contract;
watchers poll. The MVP's websocket push is dead and must not return.

### D10 — outputData is not in the request record (2026-07)
**Decision:** Response-side data lives in the responses contract, not in
`SignetEVMSignatureRequest`.
**Why:** It's written after signing; including it would force rewriting the
whole record on respond and entangle request/response lifecycles.

### D11 — Task 1.4 (field right-sizing) deferred (2026-07-04, task 1.4)
**Decision:** The protocol-freeze/right-sizing pass is ON HOLD pending a
discussion with the MPC team: shrinking the padded fields deviates from the
standard signet request structure used on other chains, and whether Midnight
may deviate (to win proving time: est. ~419K → ~150-250K rows) is their call.
**Impact:** Current widths (path 256, funcSig 256, params 512, schemas 256,
caip2Id/dest 64) remain the wire format for now. Any persistent deployment
made before 1.4 lands must be treated as throwaway — 1.4 changes stored bytes
AND all request ids. Executors of Phases 2-4: proceed, but do not promote any
deployment to "long-lived" status until 1.4 is resolved either way.

### D12 — Path building + LE word encoding confirmed (2026-07-04, tasks 1.1-1.2)
**Decision:** `signetPathOfCommitment(commitment)` in signet-midnight is the
one true way to build the path field off-chain (hex via `requestIdHex`,
zero-padded to `PATH_BYTES = 256`). Confirmed empirically via the round-trip
test: Compact `X as Field as Bytes<32>` is LITTLE-ENDIAN embedding — a
`Bytes<20>` address becomes `address-bytes || 12 zero bytes`, a `Uint` amount
becomes its LE bytes. Decode ABI-word args off-chain with LE (the old
monitor's `bytesToBigintLE` convention was correct).
**Impact:** Phase 5 monitor rewrite and any tx-builder port must use LE for
arg words. Also fixed in the same commit: signet-midnight `tests/` are now in
tsconfig `include` — before `316e905` the type tripwires never actually
guarded `npm run build`.

### D1# — NEVER ADD REFERENCES TO THIS TASK FILE ANYWHERE OUTSIDE OF THIS FILE
**Decision:** never add references to this file outside of this file. it will be deleted once these tasks are complete.
e.g. the following should NEVER BE DONE:
```ts
// Follow-ups (task.md 2.3): call initialize(vaultEvmAddress) as a circuit
// call once the deploy tx lands, and write deployments/<network>.json.
```
DON'T DO THAT EVER!

### D13 — Client-facing circuit names from the CLI sketch (2026-07-05)
**Decision:** Vault circuits adopt request/claim/refund naming:
`requestDeposit` (was `deposit` — rename pending, task 4.1), `claimDeposit`
(MVP `claim`), `requestWithdraw` (MVP `withdraw`), `refundWithdraw` (MVP
`completeWithdraw`). `packages/cli` was scaffolded under these names
(commander command surface, config/identity wiring via lib, network
boundaries stubbed with NotImplementedError; `parseIdentitySecretKey`
promoted from vault deploy.ts into lib as its second consumer appeared).
**Why:** The request/complete split IS the protocol's shape — one circuit
records the signature request, another presents the MPC attestation; the
names say which half you're calling. Chosen by Bernard in the CLI sketch.
**Alternatives rejected:** keeping MVP names with a CLI-level mapping — a
permanent naming seam for zero benefit pre-deployment.
**Impact:** vault-contract rename before any persistent deployment (circuit
names are part of the generated API and call-tx key location); Phases 8–9
port under the new names. Note `refundWithdraw` settles BOTH branches
(success finalizes, failure refunds) — name kept per the sketch despite the
wider semantics.

### D14 — Circuit calls via midnight-js callTx, not hand-rolled call txs (2026-07-05)
**Decision:** Clients call circuits on deployed contracts through midnight-js:
`findDeployedContract(providers, ...)` → `contract.callTx.<circuit>(...)`,
with lib porting midday's `buildProviders` + WalletFacade adapter
(`app/playground/lib/providers.ts`, proven working in
`clis/14_data_extraction`). The CLI's `CliContext` (config + lazy
`publicDataProvider()`/`vault()` getters, built in main.ts and injected into
every command) is the seam; commands never assemble transactions.
**Why:** compact-js binds and locally runs circuits but does NOT assemble +
prove + submit a ledger call transaction — midnight-js is the orchestration
layer for exactly that, and its `callTx` balances coin-bearing calls
(claimDeposit's mint, requestWithdraw's escrow) for free.
`findDeployedContract` consumes the same compact-js CompiledContract lib's
`makeCompiledContract` already builds, so deploy (2.1, compact-js) and call
(midnight-js) share one contract binding.
**Alternatives rejected:** hand-porting midnight-js-contracts'
`createUnprovenLedgerCallTx` internals (ContractCallPrototype → Intent →
fromPartsRandomized) into lib — reimplements maintained code and deferred
Zswap offer support to Phase 8 for no benefit.
**Impact:** cli depends on `@midnight-ntwrk/midnight-js` (4.1.1 = latest,
matches lib); 4.2 is a midday port, not new plumbing; 8.3's client-side coin
work disappears. midnight-js reads a process-global network id
(`setNetworkId`) — one call at entry, the only global in the stack.
**Amendment (2026-07-05, task 4.2):** provider composition lives in the
CONTRACT package (`vault-contract/src/providers.ts` — zk path, private-state
id, circuit-id union are all vault-specific; the contract package is the
SDK), not in lib; lib carries only the generic WalletFacade adapter
(`createWalletAndMidnightProvider`). The CLI context is EAGER: built once per
command inside a synced wallet session (`withCliContext`), no lazy getters.

### D15 — MIDNIGHT_VAULT_CONTRACT_ADDRESS (2026-07-05, task 4.4)
**Decision:** The vault-contract-address env var is
`MIDNIGHT_VAULT_CONTRACT_ADDRESS` (was `VAULT_CONTRACT_ADDRESS` in the cli).
Renamed across cli src/tests/README and the root `.env.example` (which was
also rewritten from its stale MVP copy — dead `MIDNIGHT_WALLET_SEED*` /
`MPC_WS_URL` vars dropped).
**Why:** It coexists in the same env block with `EVM_VAULT_ADDRESS` (the
vault's derived EVM account); the `MIDNIGHT_` prefix disambiguates which
chain the address lives on. Chosen by Bernard.
**Impact:** cli only (config field name `vaultContractAddress` unchanged).

### D16 — Epsilon derivation ported at v1.0.0, not imported from signet.js (2026-07-05, task 4.4)
**Decision:** `deriveEvmAddress` lives in signet-midnight
(`src/epsilon-derivation.ts`), ported from the MVP's `crypto-utils.ts`:
`keccak256("sig.network v1.0.0 epsilon derivation,<chainId>,<contract>,<path>")`
(COMMA-separated, default chainId `midnight:testnet`), point-added to the MPC
root secp256k1 key (@noble/curves replaces tiny-secp256k1; epsilon reduced
mod n first — noble throws on unreduced scalars).
**Why:** signet.js's `deriveChildPublicKey` implements the v2.0.0
COLON-separated scheme — incompatible with the live fakenet response server
(solana-signet-program `CryptoUtils.ts`), which hashes the v1.0.0 comma
string. Same-derivation-or-wrong-address is load-bearing, so the port pins
golden vectors generated from the MVP implementation in its tests.
**Alternatives rejected:** importing signet.js (derives different addresses);
waiting for the server to move to v2 (blocks the whole e2e flow).
**Impact:** When the MPC server upgrades to v2 derivation, this module and
its tests change together; the "belongs in signet.js" header comments mark
the upstream path. Same-file ports: `deriveJubjubKeypair` (seed of the
schnorr module, Phase 8) and `deriveMpcKeys`/`generateMpcRootKey`.

### D17 — Integration suite = one ordered vitest file with an env accumulator (2026-07-05, task 4.4)
**Decision:** The pipeline is a single `tests/e2e.test.ts` with sequential
`it` steps sharing a module-level env accumulator (`{...repo .env,
...process.env}` — real env wins; process.env itself never mutated; passed
explicitly to `getCliConfig(env)`/`getDeployConfig(env)`/subprocesses). Each
derived value lives under its canonical env-var name: presence = the step's
skip signal, and the printed hand-off block is exactly those keys. Gating:
`describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)` (flag read from the
real env only) + `--bail 1` in `test:integration` for abort-on-first-failure.
Vault deploys run in-process via the new `deployVault(env)` export
(vault-contract `src/deploy-vault.ts`); only the compact compiler is shelled
out to. The suite loads the repo-root `.env` itself via a minimal parser
(`src/env-file.ts`) — nothing else in the repo reads `.env`, and node bans
`--env-file` in NODE_OPTIONS.
**Why:** vitest runs test FILES in parallel isolated workers — cross-file
env mutation breaks; same-file `it`s run sequentially with zero config (repo
keeps having no vitest.config anywhere; per-`it` timeouts as the third arg).
Skip-if-set makes run 2 reuse run 1's deployment, which the two-phase MPC
hand-off requires anyway (the server can only be configured after the first
run prints the contract address).
**Impact:** 4.5's manifest-based "ensure deployed" can replace the manual
env-block reuse later without changing the suite's shape. The initialize
step already drives the cli's wired `initialize` + `readState` (the live
half of 4.2's *Done when*).

<!-- Append new decisions below this line. -->
