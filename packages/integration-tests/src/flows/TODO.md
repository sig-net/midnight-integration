# TODO: remaining flow files (`benchmark.test.ts`, `false-claimer.test.ts`)

A work order for the flow files not yet built. The groundwork they need
already exists — read these before writing code:

- Repo-root `AGENTS.md` (non-negotiable rules — especially "orchestration
  lives in the cli, never in tests"), then
  `packages/integration-tests/README.md` (the pipeline, the registration
  points, the env vars), then `.claude/skills/e2e/SKILL.md` (running it,
  funding, MPC responder hand-off, failure recovery).
- **Flow helpers in this directory**: `deposit.ts` exports
  `runDepositRoundTrip(session, env, { amount, reuseRequestId? })` — the
  whole deposit leg as arrange-stage plumbing, returning
  `{ requestId, timings }` where `timings` is wall-clock milliseconds per
  leg keyed by cli command name. `withdraw.ts` exports the withdraw flow as
  four legs (`requestWithdrawLeg`, `pollSignedWithdrawLeg`,
  `pollWithdrawAttestationLeg`, `settleWithdrawLeg`) so a flow can
  intervene mid-flow; no leg asserts the EVM outcome.
- **Reference flow files**: `tests/happy-day-e2e.test.ts` (long-hand steps,
  golden events — deliberately does NOT use the helpers) and
  `tests/deposit-withdrawal-failure-refund.test.ts` (helper-driven, failure
  injection, rerun/resume conventions).
- **Registration points** — every new flow file must touch all three:
  `FILE_ORDER` in `vitest.config.ts`, a `test:integration:<name>` package
  script, a `test:integration-tests:<name>` root script. Gate the suite with
  `describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)` and give it its own
  funding + vault-initialized preflight tests.

## `benchmark.test.ts`

Consume the `timings` records the flow helpers already produce: run
`runDepositRoundTrip` (and optionally the withdraw legs, timed the same
way) and report per-leg wall-clock — request/prove, MPC signature latency,
EVM confirmation, attestation latency, claim/settle proving. Decide and
document what "report" means (console table vs a JSON artifact) before
building; there is no assertion budget yet, so start with reporting only —
a regression gate needs baseline data first.

## `false-claimer.test.ts`

Prove the vault's in-circuit caller-identity check: a deposit request
recorded for identity A must not be claimable by identity B. Arrange a
deposit round trip up to (but not including) the claim — build the arrange
stage from the cli commands, not by copying `runDepositRoundTrip` (it
claims at the end; consider extending it with a `skipClaim` option
instead). Then attempt `claimDeposit` with a SECOND user identity
(`USER_SEED` / `VAULT_USER_SECRET_KEY` differ — mind the
`midnight-level-db` stale-state gotcha in the README) and assert the
circuit rejects and the request stays on the ledger, claimable by the
rightful identity afterwards (leave no stranded deposit: finish the run by
claiming with identity A so funds keep cycling).
