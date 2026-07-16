---
name: contract-change
description: >
  Playbook for changing a Compact contract in this workspace and fully
  retesting it end-to-end. Use when extending or modifying a contract circuit
  or struct (packages/*-contract), extending the generic caller e2e to drive
  it, or lifting shared protocol code into the signet-midnight seed. Covers
  the layer architecture, the MPC request/response pipeline (which stage maps
  to which circuit and test), the change→compile→retest decision tree (rerun
  vs redeploy), the TS-twin / descriptor lockstep that silently breaks
  proofs, and the infra failures that surface mid-retest. Defers RUNNING the
  stack to /e2e and the non-negotiable rules to AGENTS.md.
---

# contract-change — change a contract and retest it end to end

Plain markdown on purpose: any agent or human can follow it. This is the
*connective* knowledge — how a single change threads through the layers and
how to prove it. It does not restate what already has a home:

- **Non-negotiable rules** (seed lives once, never a TS twin of a pure circuit,
  simulator-only unit tests, the deploy split, no emitted JS, always
  `build && test`) → root [`AGENTS.md`](../../../AGENTS.md) and each package's own
  `AGENTS.md`. Read them; this skill assumes them.
- **Running / redeploying the stack** (fakenet responder hand-off, pacing,
  failure playbooks) → the [`/e2e`](../e2e/SKILL.md) skill.
- **Invariants worth remembering** (enum ≥2 variants, compact-js symbol
  identity, response-server dependency boundary, cross-contract calls) →
  the project memory index.

## The four layers — and the one question that places any change

Every change belongs to exactly one layer. Ask: *is this protocol machinery,
the central notifier, a client contract, or the driver?*

| Layer | Package | Owns | NEVER holds |
|---|---|---|---|
| **Seed SDK** | `packages/signet-midnight` | Client-agnostic protocol: request/response structs, request-id hashing, Schnorr, the `CompactType` descriptors and readers, `pureCircuits` (compiled `circuits.compact`) | Anything specific to one client contract |
| **Singleton notifier** | `packages/signet-contract` | The one central contract every client cross-contract-calls to register a `SignBidirectionalNotification` in its registry. The MPC discovers requesters by polling ITS state | Application logic; per-client state |
| **Client contract** | `packages/caller-contract` | One requester's circuits + ledger. The caller is the SMALLEST possible client: submit a request with contract-fixed calldata, verify the Schnorr response in-circuit. Seals the signet contract address and the MPC key at deploy | Reusable protocol code — that belongs in the seed. Business logic beyond what exercising the singleton needs |
| **Driver** | `packages/integration-tests` | Orchestration a downstream app would do: build circuit args, submit calls via midnight-js, poll the signet contract, verify responses. The e2e drives the caller THROUGH these sequences | Rules a contract should enforce |

Placement rule of thumb: **if a second contract would ever want it, it goes in
the seed** (`signet-midnight`), never copied into a client. If it decides
what THIS client allows, it goes in the client contract. If it is
fetch/poll/submit sequencing, it goes in the integration tests (or a
downstream app). See AGENTS.md "Shared plumbing lives ONCE" and the
per-package `AGENTS.md`.

## The MPC request/response pipeline

A request is a round trip across all four layers. Each stage maps to a
concrete circuit or e2e leg (see
`packages/integration-tests/tests/signet-caller-e2e.test.ts`) — know this map
before touching any stage:

1. **Request** — the client circuit (`submitSignatureRequest`) builds the
   contract-enforced calldata, inserts the request into its request index,
   and cross-contract-calls the signet contract to register a
   `SignBidirectionalNotification` in its registry. The e2e recomputes the
   request id off-chain (`calculateRequestId`) and asserts it landed on the
   ledger.
2. **Discover + sign** — the MPC responder (external, `/e2e` starts it) polls
   the **signet contract's** notification registry, resolves the request from
   the requester's RAW ledger, signs the EVM tx, and posts a signature
   response to the signet contract.
3. **Poll signed tx** — the e2e reconstructs a typed ethers `Transaction`
   from the request + response and verifies it recovers to the caller's
   epsilon-derived account.
4. **Settle** — the client circuit (`verifyResponse`) verifies a Schnorr
   attestation IN-CIRCUIT (MPC pk hash, signature, the attested output) and
   **removes the request** (double-settle protection). The fakenet only
   attests after observing a broadcast, so the generic e2e signs the
   attestation in-test from the suite's `MPC_ROOT_KEY` — the same key
   material the fakenet holds.

The reader that stages 2–4 lean on (`SignetRequestResponseReader`) reads RAW
ledger/state exactly as the MPC does — the same view on both sides is the point.

## The change → retest decision tree

**1. Classify the change.**

- **TS-only** (reader, descriptor, seed TS helper, e2e sequencing): no
  recompile of circuits. `yarn compile` is still needed once if
  `src/managed/` is absent.
- **`.compact` edit that does NOT alter a circuit's proof** (comment, a
  non-hashed rename): `yarn compile` (default `--skip-zk`) regenerates
  `src/managed/`; simulator tests and typecheck are enough.
- **`.compact` edit that alters a circuit, a struct layout, or the request-id
  hash domain**: the proving keys change. This forces a **redeploy**.

**2. Verify in-process first (fast, no stack).**

- `yarn build && yarn test` in the member you touched (AGENTS.md: `tsx`
  and vitest do NOT typecheck — "it runs" is not verification). Root
  `yarn compile` (skip-zk) wipes prover keys, and signet-contract's `build`
  gates on its keys — restore with `yarn compile:signet-contract:zk` before
  a root build, and never build while a zk compile is still running.
- Contract packages carry simulator unit tests (`tests/contract.test.ts`)
  that exercise circuits in-process via `compact-runtime`. Add the happy
  path AND the reject cases there — it is the cheapest place to prove a
  circuit change.

**3. Retest end to end.** Hand off to [`/e2e`](../e2e/SKILL.md):

- **TS-only or skip-zk change** → `/e2e` (rerun): setup steps skip against
  the kept addresses; only the flow re-runs. ~2 min.
- **Circuit/struct/hash change** → `/e2e redeploy`: zk keygen (~10+ min) +
  the responder hand-off, all in one run. Background it.

**4. Reuse completed work to iterate on a late stage.** To exercise only the
settle leg without re-proving a submit, set `CALLER_REQUEST_ID=<an existing
request id>` before `/e2e`: the submit leg short-circuits and the suite
reaches your stage on real state (the run prints the id as it goes).

## Sharp edges that fail silently

- **TS twins and hand-composed descriptors must move in lockstep with the
  `.compact` structs.** The seed's readers decode ledger bytes with hand-written
  `CompactType` descriptors (field order + alignment) and reconstruct request
  ids with `calculateRequestId`. These are the *sanctioned* exception to
  AGENTS.md's "never a TS twin of a pure circuit" rule — they exist only because
  the generic request circuits are type-parameterized and cannot be compiled.
  Change a struct's fields or order in Compact and you MUST change its descriptor
  to match byte-for-byte; a mismatch does not throw at the boundary — it decodes
  garbage or breaks proof agreement downstream. Everything that CAN be compiled
  must instead be called as `pureCircuits.<name>` — never re-port it in TS.
- **Ledger field ordering is load-bearing.** In a client contract the request
  index is ledger field 0 and the nonce counter field 1; the MPC locates them by
  position knowing only the contract address. Do not declare ledger state above
  them.
- **Keep enums in hashed structs ≥ 2 variants** — a 1-variant enum hashes as a
  zero-width atom and desynchronizes the compiler from the ledger (see the
  memory on this and AGENTS `TxParamType`'s padding variant).
- **A client seals the signet contract address and the MPC key at deploy.**
  Its EVM accounts are epsilon-derived from its contract address, so a
  redeploy moves them; on the local loop nothing is funded, so this costs
  nothing (the parked Sepolia sweep lives in `docs/e2e-sepolia-runbook.md`).

## Infra failures that surface during retest (not your change)

- **Proof server OOM — container `Exited (137)`.** Heavy circuits can exhaust
  its memory. Symptom: `ECONNREFUSED 127.0.0.1:6300` mid-proving. Fix:
  `docker restart midnight-proof-server`, re-run the stage (reuse the request
  id per step 4).
- **`DustDoubleSpend` — node `Custom error: 196`** on a contract call. A stale
  local wallet dust view spent an already-consumed dust nullifier. Transient;
  a fresh wallet session (rerun) resyncs and picks unspent dust. Confirm in
  `docker logs midnight-node`.
- **Stages 2–4 hang** if the MPC responder is down or watching a stale signet
  contract address. `/e2e` covers the hand-off.

## Worked shape: add a circuit + its test

1. Decide the layer (usually: circuit in a client contract, any reusable
   struct/helper in the seed).
2. Write the circuit in the `.compact`; if it consumes/produces a signet struct,
   confirm the seed already models it — add/extend the struct AND its descriptor
   together if not.
3. `yarn compile` in the contract package; add simulator tests for the happy
   path and every reject.
4. `yarn build && yarn test` in each touched member.
5. Extend `packages/integration-tests/tests/signet-caller-e2e.test.ts` with a
   leg that drives the new circuit and asserts a publicly-observable effect (a
   ledger insert/removal is stronger than a return value).
6. Retest per the decision tree. Assert on RAW ledger state read back through
   the same reader the MPC uses.
