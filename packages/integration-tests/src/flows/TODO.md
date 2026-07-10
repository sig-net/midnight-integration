# TODO: flow helpers + `deposit-withdrawal-failure-refund.test.ts`

This is a self-contained work order. An agent (or human) given only this file
and the repo has everything needed to complete the task. Do the two halves
TOGETHER — the flow helpers exist to serve the failure-refund test, and
building them without a consumer invites the wrong abstraction.

## 0. Context for a fresh session

- You are in the `midnight-erc20-vault-refactor` repo: a plain npm-workspaces
  monorepo (`packages/*`), no turbo/nx. Run every npm script from the REPO
  ROOT. All work for this task lives in `packages/integration-tests` plus
  the three registration points (§1, one of which is in the repo-root
  `package.json`) and doc updates (§5).
- Read, in this order, before writing code: the repo-root `AGENTS.md`
  (non-negotiable rules — especially "orchestration lives in the cli, never
  in tests" and the no-build-step conventions), then
  `packages/integration-tests/README.md` (what the pipeline does), then
  `.claude/skills/e2e/SKILL.md` (how to run it, funding, MPC responder
  hand-off, failure reading).
- There is NO build step: vitest/tsx execute TypeScript directly, imports use
  explicit `.ts` extensions, and `npm run build` is a no-emit typecheck. Both
  `npm run build` and plain `npm run test` (offline no-op) must stay green.
- The reference implementation for every leg you will wrap is
  `packages/integration-tests/tests/happy-day-e2e.test.ts` — locate step
  bodies by test name, not line number.
- The cli surface you may sequence (import from `@midnight-erc20-vault/cli`;
  implementations in `packages/cli/src/commands/`): `initialize`,
  `requestDeposit`, `claimDeposit`, `requestWithdraw`, `completeWithdraw`,
  `pollSignatureResponse`, `pollRespondBidirectional`, `broadcastEvm`,
  `readState`, plus `createCliContext`, `getCliConfig`, `getUserIdentity`,
  `requireConfigValue`, `ERC20_TRANSFER_GAS_LIMIT`,
  `ERC20_TRANSFER_MAX_FEE_PER_GAS`. Types: `RequestIdHex`,
  `RespondBidirectional`, `executionSucceeded`, `requestIdBytes` from
  `@midnight-erc20-vault/signet-midnight`; `Transaction` from `ethers`;
  `E2eSession` from `../session.ts` (this directory's parent).
- `broadcastEvm` semantics you must design around (see
  `packages/cli/src/commands/broadcast-evm.ts`): it is IDEMPOTENT
  (short-circuits when the tx already mined), but it THROWS on (i) a tx that
  mined and REVERTED (`status 0`) and (ii) a BURNED nonce (a different tx
  consumed the slot, the signed tx can never mine). A failure-injection test
  therefore cannot expect `broadcastEvm` to return normally for the failing
  transfer — catch the specific expected throw, and let the MPC responder's
  attestation (not the broadcast result) drive the refund assertions.

## 1. How this package works (orientation)

The architecture, in one pass:

- **Setup runs in vitest globalSetup** (`src/setup/global-setup.ts`, wired in
  `vitest.config.ts`): environment preflight, MPC key derivation, zk-compile
  + deploy of both contracts, derived-EVM-address checks, MPC hand-off
  banner. It runs ONCE in the main process before ANY test file — including
  when a single file is selected — and each step skips itself when its
  canonical env var is already set (rerun against kept addresses).
- **The env accumulator** is handed to test workers via vitest
  provide/inject. Flow files call `injectE2eEnv()` from
  `src/flow-hooks.ts` at module top; `requireEnv(env, name)` from
  `src/e2e-env.ts` asserts a value is present.
- **Flow files never run in parallel**: `vitest.config.ts` sets
  `fileParallelism: false` and a `PipelineSequencer` pinned to the explicit
  `FILE_ORDER` list. `--bail 1` (set by the `test:integration` script) stops
  everything at the first failure.
- **Per-file lifecycle**: each flow file creates ONE
  `createE2eSession(env)` (`src/session.ts`) at module scope — lazy wallet
  facade + `CliContext` + MPC-style `SignetRequestResponseReader` — and calls
  `session.stop()` in `afterAll`. `installFlowHooks()` (`src/flow-hooks.ts`)
  prints per-test headers and honors `STEP_THROUGH`.
- **Golden-event polling**: `pollDecodedSignetEvent` (`src/signet-events.ts`)
  owns the indexer poll loop; the test picks the decoder and asserts.
- **The suite gate**: every flow file wraps its suite in
  `describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)` so plain
  `npm run test` stays offline.
- **Registration points — every new flow file must touch all three**:
  1. `FILE_ORDER` in `packages/integration-tests/vitest.config.ts`;
  2. a package script `test:integration:<name>` in
     `packages/integration-tests/package.json`
     (pattern: `npm run test:integration -- tests/<name>.test.ts`);
  3. a root script `test:integration-tests:<name>` in the repo-root
     `package.json`
     (pattern: `npm run test:integration:<name> -w @midnight-erc20-vault/integration-tests`).
- **The AGENTS.md boundary rule**: orchestration primitives live in the cli
  package (`@midnight-erc20-vault/cli`), never in tests. Flow helpers in this
  directory may only SEQUENCE exported cli commands and plain reads/asserts.
  If a flow needs a new capability (a new contract call, a new polling
  primitive), it goes into the cli package first.

## 2. Helpers to build in this directory

Crib the step bodies from `tests/happy-day-e2e.test.ts` — find them by test
name (line numbers drift). `happy-day-e2e.test.ts` itself must NOT be
rewritten to use these helpers: its long-hand steps each carry their own
assertions (golden events, MPC-style ledger reads) and that visibility is
the point of that file.

### `deposit.ts`

```ts
export async function runDepositRoundTrip(
  session: E2eSession,
  env: NodeJS.ProcessEnv,
  opts: { amount: bigint },
): Promise<{ requestId: RequestIdHex; timings: Record<string, number> }>
```

Sequences the whole deposit leg as arrange-stage plumbing (crib from the
tests named `requestDeposit …`, `pollSignatureResponse: poll signet contract
for sweep transaction …`, `broadcast deposit sweep evm txn …`,
`pollRespondBidirectional: poll signet contract for sweep transaction …`,
`claimDeposit …`):

1. `getTransactionNonce(EVM_RPC_URL, EVM_USER_ADDRESS)` (`src/evm.ts`);
2. `requestDeposit(context, { amount, evmNonce })`;
3. `pollSignatureResponse(context, { requestId, expectedSigner: EVM_USER_ADDRESS, … })`;
4. `broadcastEvm(context, { transaction })`;
5. `pollRespondBidirectional(context, { requestId, … })`;
6. `claimDeposit(context, { requestId })`.

Record wall-clock timings per leg (a benchmark test will consume them
later). Skip nothing silently — throw with pointed messages.

### `withdraw.ts`

The failure-refund test must INTERVENE mid-flow, so do NOT build one opaque
round trip. Split into legs (crib from the tests named `requestWithdraw …`,
`pollSignatureResponse: … withdraw …`, `broadcast withdraw evm txn …`,
`pollRespondBidirectional: … withdraw …`, `completeWithdraw …`):

```ts
export async function requestWithdrawLeg(session, env, opts: {
  amount: bigint; destEvmAddress: string; evmNonce: bigint;
}): Promise<RequestIdHex>          // escrows shielded tokens, returns request id

export async function pollSignedWithdrawLeg(session, env, opts: {
  requestId: RequestIdHex;
}): Promise<Transaction>           // MPC-signed tx, verified against EVM_VAULT_ADDRESS

export async function pollWithdrawAttestationLeg(session, env, opts: {
  requestId: RequestIdHex;
}): Promise<RespondBidirectional>  // NO success assertion — caller decides

export async function settleWithdrawLeg(session, env, opts: {
  requestId: RequestIdHex;
}): Promise<void>                  // completeWithdraw; caller asserts ledger outcome
```

Note the deliberate difference from the happy-day test:
`pollWithdrawAttestationLeg` must NOT assert `executionSucceeded(...) === true`
— the failure-refund test needs the failure attestation to flow through.

## 3. The failure-refund test (`tests/deposit-withdrawal-failure-refund.test.ts`)

### What it must prove

A withdraw whose EVM transfer FAILS ends with:

1. the MPC attesting failure:
   `executionSucceeded(attestation.serializedOutput) === false`
   (`executionSucceeded` is exported from
   `@midnight-erc20-vault/signet-midnight`; first output byte is the flag);
2. `completeWithdraw` taking the REFUND branch in-circuit: the escrowed
   shielded vault tokens return to the caller (the surrendered value is NOT
   burned), and the request + its pending-withdrawal marker are consumed.

Mirror the happy-day `completeWithdraw` test's ledger assertions with the
refund outcome: before settling, `signetRequestsIndex.member(requestKey)`
and `refundRecipient.member(requestKey)` are both true (via
`vaultContractLedger` from `@midnight-erc20-vault/vault-contract`,
`requestIdBytes` from signet-midnight); after, both false. The refunded
shielded balance itself is not publicly observable — if the cli exposes a
local-state read that shows the caller's vault-token balance (see
`readState`), assert the delta; otherwise the ledger-marker consumption plus
the failure attestation is the observable contract.

### Arrange

The caller must hold shielded vault tokens to escrow → run
`runDepositRoundTrip` first (this is exactly why the helper exists). Funding
follows the same preflight minimums as the happy-day deposit leg
(`EVM_USER_ADDRESS`: ≥ 0.009 ETH + ≥ 0.1 USDC; `EVM_VAULT_ADDRESS`: ETH for
withdraw gas). Give the file its own funding preflight test (first `it`) and
also a read-only "vault is initialized" check — fail with
"run tests/happy-day-e2e.test.ts first (or initialize the vault)" on a fresh
deploy, since `initialize` lives in the happy-day file.

### Forcing the EVM failure — candidate strategies (implementer's choice)

In every strategy, remember `broadcastEvm` THROWS for the failing transfer
(§0) — assert the expected throw, then wait for the MPC's failure
attestation.

- **(a) Withdraw more than the vault's EVM ERC20 balance.** The transfer
  mines and REVERTS (`status 0`) — deterministic, observable on-chain, and
  a mined-reverted tx is squarely what the responder's execution-result
  attestation is for. The user can only escrow what they hold, so this
  needs the user's shielded balance to exceed the vault's on-chain ERC20
  balance (e.g. two deposit round trips whose sweeps you then partially
  drain, or a prior run's leftovers). The setup arithmetic is fiddly —
  compute it from live balances, never hardcode.
- **(b) Burn the vault account's nonce.** The withdraw request pins
  `evmNonce` (fetched from the chain). Before broadcasting the MPC-signed
  tx, land ANY other tx from the vault's derived account at that nonce — the
  signed withdraw tx then can never mine (`broadcastEvm` throws its
  burned-nonce error). Needs a way to send from the vault's derived account:
  fakenet-only key derivation from `MPC_ROOT_KEY` exists in
  `.claude/skills/e2e/scripts/sweep-derived-funds.ts` (see how it derives
  the epsilon key with `--path vault`) — but note that signing locally with
  a derived key is a test-harness move the cli deliberately does not export;
  keep it in test-support code and mark it fakenet-only.
- **(c) Request with a stale/burned nonce directly.** Pass an `evmNonce`
  that is ALREADY used (current nonce − 1, requires the vault account to
  have sent ≥ 1 tx). The signed tx is invalid on arrival — no second
  transaction needed.

For (b) and (c) the tx NEVER mines, so first verify how the responder
attests a transaction that cannot land (does it watch the chain for a
receipt, time out, or attest based on its own broadcast attempt?) — read the
responder in the `sig-net/solana-signet-program` checkout before choosing.
If it only attests on a mined receipt, (a) is the only strategy that
produces the failure attestation the refund branch needs. Whichever
strategy: document it in the test header comment, keep it deterministic, and
keep the file rerun-tolerant (kept addresses; use `logSkip` conventions from
`src/output.ts` when a leg was already consumed by a prior run, mirroring
the happy-day skips).

## 4. Operational constraints and known infra failures

- The **fakenet MPC responder must be running** against the current contract
  addresses (`.claude/skills/e2e/SKILL.md`, "MPC hand-off"); without it all
  polls time out. Start: `yarn response` in the
  `sig-net/solana-signet-program` checkout (background, own log); healthy
  startup logs `watching signet contract events at <signet address>`.
- Sepolia funding minimums + the fund-sweep script: SKILL.md. Fund state is
  shared with the other flows — this file runs AFTER `happy-day-e2e.test.ts`
  in `FILE_ORDER`, which leaves the user's USDC back on `EVM_USER_ADDRESS`
  and the vault's gas ETH spent by one transfer. Check LIVE balances against
  the preflight minimums before running; the vault's derived account drains
  ~one gas budget per withdraw and has historically sat near the 0.003 ETH
  floor.
- **Known infra failure — the proof server OOMs at the claim step.** On
  three consecutive full runs the `midnight-proof-server` container was
  OOM-killed (`docker ps -a` shows `Exited (137)`) mid-`claimDeposit`,
  surfacing as `ECONNREFUSED 127.0.0.1:6300`. Recovery:
  `docker start midnight-proof-server`, then rerun with
  `DEPOSIT_REQUEST_ID=<request id printed by the failed run>` so the suite
  resumes from the pending request instead of spending another deposit
  (`broadcastEvm` is idempotent, so the already-mined sweep is skipped
  through). Budget for this happening during your verification runs.
- midnight-js persists private state in
  `packages/integration-tests/midnight-level-db/` keyed by seed; stale state
  wins if identity secrets change under the same seed — `rm -rf` it to
  reset (README gotchas).
- Never set `STEP_THROUGH=1` unattended (hangs on stdin).
- A full run of this file costs real Sepolia gas and several proof-server
  rounds — expect minutes, use generous per-`it` timeouts like the happy-day
  file (5–15 min).

## 5. Definition of done

- [ ] `src/flows/deposit.ts` + `src/flows/withdraw.ts` built as specified.
- [ ] `tests/deposit-withdrawal-failure-refund.test.ts` added, gated with
      `describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)`, with its own
      preflight (funding + vault-initialized) as the first tests.
- [ ] All three registration points updated (`FILE_ORDER`, package script,
      root script — see §1).
- [ ] `npm run build` clean from the repo root; plain `npm run test` still an
      offline no-op.
- [ ] `npm run test:integration-tests:deposit-withdrawal-failure-refund`
      passes against the live stack (responder running, addresses kept).
- [ ] `npm run test:integration-tests` (all flows, serialized) passes.
- [ ] `packages/integration-tests/README.md` + `.claude/skills/e2e/SKILL.md`
      updated (new flow file, its script, its funding needs).
- [ ] This TODO.md deleted, or trimmed to a work order for the remaining
      future flows (`benchmark.test.ts`, `false-claimer.test.ts`).
