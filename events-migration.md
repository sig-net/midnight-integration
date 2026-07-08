# Events migration — task breakdown

Migration of the signet protocol layer from **ledger-state polling** to **MIP-0002
contract events** (`Misc { name: Bytes<32>, payload: Bytes<256> }`), converging with
the wire protocol prototyped in the old repo's `signet-signer` contract
(`midnight-erc20-vault/boilerplate/contract/src/signet-signer.compact`) and its
normative spec (`midnight-erc20-vault/docs/signet-midnight-events.md`, tag `SGN1`).

Phases are ordered by dependency; each ends at a verifiable milestone. No timelines.

---

## Phase 0 — Protocol alignment & spec freeze

Joint phase with the signer/MPC colleague. Every later phase builds on these
decisions; nothing downstream should start until the spec is frozen.

### Decisions to make

- [ ] **Attestation crypto for `respond_bidirectional`** — the load-bearing decision.
      SGN1 uses a phase-2 secp256k1 ECDSA signature (off-chain verified, Solana/Canton
      parity). The vault's `claimDeposit` requires an **in-circuit verifiable**
      attestation, i.e. Schnorr on Jubjub over `signetAttestationMessage`
      (secp256k1 ECDSA cannot be verified in a Compact circuit). Outcome needed:
      the MPC produces the Jubjub Schnorr attestation
      (`{serializedOutput, outputLen, pk, announcement, response}`), replacing or
      alongside the ECDSA phase-2 signature. This changes what the real MPC
      implements — settle before MPC work calcifies.
- [ ] **Identity on the wire: commitment vs path.** Adopt SGN1's
      `commitment: Bytes<32>` on the wire with `path = lowercase-hex(commitment)`
      reconstructed off-chain (drops `path: Bytes<256>`,
      `assertPathCommitment` / `assertHexOf` / `charToNibble` from the shared surface).
- [ ] **Commitment domain string.** One tag for everyone — signer uses
      `"signer:user:"`, vault uses `"vault:user:"`. This defines derived EVM
      addresses permanently; pick one (or explicitly decide per-requester tags are
      intended, and note the consequence: same secret key ⇒ different derived
      accounts per requester).
- [ ] **Request-id scheme.** SGN1: `SHA-256(tail_1 ‖ … ‖ tail_P)` over the exact
      padded 224-byte tails (consumer rehashes received bytes — right property for
      events). Decide whether to fold in a domain tag / event name (cheap; SGN1
      currently relies on part-count differences + name grammar for kind separation).
- [ ] **Struct grouping & field order.** Freeze the canonical structs
      (`EVMTransactionParams`, `EVMCalldata<4>`, routing params) and the
      part-boundary mapping. Known deltas: `funcSig`/`argCount` order
      (Signet.compact vs SGN1 part 2), `algo` placement (routing struct vs
      reserved-in-`sign`-only), calldata split across parts 2/3.
- [ ] **Wire version tag.** Any layout change ⇒ bump to `SGN2` per the spec's
      coexistence rule; unchanged ⇒ adopt `SGN1` verbatim.
- [ ] **Raw `sign` request kind.** Confirm the signer's `sign(payload, keyVersion)`
      (raw 32-byte hash) becomes a first-class request kind in the shared module,
      with its own name/domain tag.
- [ ] **Contract topology.** Where do `respond` / `respond_bidirectional` circuits
      live — on each requester contract (SGN1 model: signer is requester+responder)
      or shared circuits exported by the Signet module that every requester
      instantiates? (The central signet-contract disappears either way.)

### Milestone 0

A frozen, versioned wire spec (successor of `docs/signet-midnight-events.md`)
co-signed by both sides, listing: event name grammar, part layouts, request-id
preimage, attestation message + crypto, commitment tag. Golden vectors regenerable
by both the signer TS harness and the MPC Rust consumer.

### References

- `midnight-erc20-vault/docs/signet-midnight-events.md` (SGN1 normative spec)
- `midnight-erc20-vault/boilerplate/contract/src/signet-signer.compact`
- `packages/signet-midnight/src/Signet.compact` (canonical structs + pure circuits)
- sig-net MPC canon: `chain-signatures/primitives/src/bidirectional.rs`
- MPC-side interpretation rules: SGN1 spec §"MPC-side interpretation" (epsilon/entropy derivation, finality gate, keyVersion ≥ 1)

---

## Phase 1 — Toolchain bump (no behavior change)

Events require **compactc 0.33.x / `pragma language_version >= 0.25` / ledger 9 /
compact-runtime 0.18.x**; the repo is on compactc 0.22-era pragmas and
compact-runtime `^0.16.0`. Do this as an isolated PR **before** any event code, so
regressions are attributable to the toolchain, not the migration.

### Tasks

- [ ] Bump `@midnight-ntwrk/compact-runtime` → 0.18.x and the compactc binary →
      0.33.x in every contract package (`signet-midnight`, `signet-contract`,
      `vault-contract`); repo convention is latest-deps-no-pinning.
- [ ] Bump midnight-js → 5.x (`PublicDataProvider` gains `queryContractEvents` /
      `contractEventsObservable`; note v5 also changes ZK-artifact integrity
      verification and cross-contract call surfaces).
- [ ] Update `pragma language_version` in all 5 `.compact` files
      (`Signet`, `Schnorr`, `circuits`, `signet-contract`, `erc20-vault`);
      fix language churn; regenerate all `managed/` outputs.
- [ ] Adapt TS to the new compiled-contract API (async circuits,
      `CircuitContext` changes — see the 0.33/0.18 compiled shape in
      midnight-js testkit `compiled/events/contract/index.d.ts`).
- [ ] Re-apply the node_modules symlink discipline for `@midnight-ntwrk` package
      identity (Symbol/global split across duplicated packages — all
      version-matched consumers must resolve to one physical copy, including the
      solana-signet-program tree).
- [ ] Check `Schnorr.compact` still compiles/behaves on 0.33 (or whether
      CompactStandardLibrary now ships jubjub Schnorr verification natively —
      if so, drop the polyfill).

### Milestone 1

Repo builds, all existing (still ledger-state-based) tests pass on the new
toolchain. No wire/behavior changes.

### References

- midnight-js v5.0.0 release notes (`docs/releases/v5.0.0/*` in midnightntwrk/midnight-js) — compactc/runtime requirements, breaking changes
- `packages/signet-midnight/src/Schnorr.compact` (polyfill header)
- compact-js symbol-identity constraint (symlink-only fix, all version-matched packages)

---

## Phase 2 — `signet-midnight`: the shared wire layer

Rebuild the package around the frozen spec. This package is the deliverable the
signer contract and the MPC consume; keep it **client-agnostic** (no vault-specific
code) per existing convention.

### Compact tasks

- [ ] `Signet.compact` — apply Phase 0 decisions to the structs:
  - [ ] keep `EVMTransactionParams`, `EVMCalldata<#n>`,
        `SignetEVMSignatureResponse`, request params grouping;
  - [ ] routing params: `path: Bytes<256>` → `commitment: Bytes<32>` (per
        decision); delete `assertPathCommitment` / `assertHexOf` /
        `charToNibble` if commitment-on-wire wins;
  - [ ] `SignetRespondBidirectional` + `signetAttestationMessage` per the
        attestation decision;
  - [ ] add the raw-payload request struct (signer `SignBody` counterpart).
- [ ] Delete the ledger-layout sections: `SignetEVMSignatureRequestIndex`,
      `SignatureResponseCounterIndex`, `SignatureResponseIndex`,
      `RespondBidirectionalIndex`, `SignetResponseKey` (keep `SignetNonce`).
- [ ] Add the event layer: `EventPart { requestId, tail }` struct, `emitPart`
      helper, per-kind part structs and `serialize<T, 224>` mappings, event-name
      constants matching the frozen grammar.
- [ ] Replace `signetEVMSignatureRequestId` with the frozen tails-hash request-id
      circuit(s), one per request kind — shared by requester contracts and
      off-chain code (never a TS re-implementation).
- [ ] Update `circuits.compact` (the compiled pure-circuit surface for off-chain
      callers) to export the new id/attestation circuits.

### TypeScript tasks

- [ ] Replace the state readers — `signature-requests-state-reader.ts`,
      `signet-contract-state-reader.ts`, `signature-state-reading.ts`,
      `signet-request-response-reader.ts` — with an **event codec + stream reader**:
  - [ ] tail (de)serializers per part struct (LE integers, zero-padding,
        ASCII strip rules per spec);
  - [ ] event-name grammar parser (ignore non-matching names);
  - [ ] reassembly: group by `(transactionId, requestId)`, completeness per
        part count, drop malformed;
  - [ ] provenance check: recompute requestId from received tails, drop on
        mismatch;
  - [ ] resume-cursor discipline: advance persisted `id` only at request
        boundaries; over-fetch `resume_id − (P_max − 1)` on reconnect, dedupe.
- [ ] Keep and re-point: `schnorr.ts`, `signature-response-verification.ts`,
      `epsilon-derivation.ts`, `mpc-keys.ts`, `constants.ts`, `signet-requests.ts`
      (request building now targets emit-based circuits).
- [ ] Golden vectors: adopt/port the signer repo's goldens harness
      (`signer/src/goldens.ts` pattern — generate by executing the compiled
      contract); commit vectors; exchange with the MPC Rust consumer.

### Milestone 2

`signet-midnight` compiles on the new toolchain; unit tests prove
encode → emit → decode round-trips; golden vectors match the colleague's
signer/Rust consumer bit-for-bit.

### References

- `packages/signet-midnight/src/` (all files above)
- SGN1 spec §"Part layouts", §"Reassembly rules", §"Request id"
- Signer goldens harness in the old repo (`signer/src/goldens.ts`, `signer/goldens/*.json`)

---

## Phase 3 — Contracts: requester + responder on events

### `vault-contract` tasks

- [ ] `requestDeposit`: keep all validation and contract-built calldata; replace
      `signetRequestsIndex.insert` with chunked `emitPart` calls (all emits in the
      guaranteed segment — **no `kernel.checkpoint()`** — preserving the
      all-or-nothing property); keep `signetNonce` as the uniquifier.
- [ ] **Redesign claim-side state** (the one genuinely new design task):
      `claimDeposit` currently reads amount/ERC20/path out of
      `signetRequestsIndex` and `remove()`s it for double-claim protection. With
      no request index:
  - [ ] claimant supplies the original request contents as circuit arguments;
        the circuit recomputes the request id and matches it against the
        claimed id (binding by hash, same trust as storage);
  - [ ] double-claim protection via a minimal claimed-set
        (`Map<SignetRequestId, Boolean>` or nullifier-set equivalent) —
        insert-once semantics;
  - [ ] depositor-only check moves from path-hex comparison to direct
        commitment equality (commitment-on-wire).
- [ ] `claimDeposit` keeps in-circuit Schnorr verification against the sealed
      `mpcPubKeyHash` + `signetAttestationMessage` (unchanged trust model).
- [ ] Decide/emit a claim event (nice-to-have for indexing; not protocol-required).
- [ ] Port the **withdraw flow** (currently `NotImplementedError` stubs in the CLI,
      no circuits in the contract) directly onto the event transport — never build
      the state-based interim version.
- [ ] Ledger-layout comment cleanup: the "request index MUST be field 0" MPC
      convention is dead; the MPC now discovers requests via the event stream +
      `contractAddress` filter.

### `signet-contract` package

- [ ] **Delete** the central contract (`signet-contract.compact`,
      `deploy-signet-contract.ts`, its providers/witnesses): both response kinds
      become `respond` / `respond_bidirectional` event-emitting circuits per the
      Phase 0 topology decision. Migrate anything still referencing it
      (deploy tooling, tests, `lib`, cross-repo consumers — see Phase 5).
- [ ] Add the responder circuits where the topology decision put them (requester
      contract or shared module instantiation).

### Milestone 3

Contracts compile; simulator/unit tests green for:
request → parts emitted (correct names, ids, tails) → claim with
attestation + request contents supplied as arguments → double-claim rejected.

### References

- `packages/vault-contract/src/erc20-vault.compact` (esp. `requestDeposit`, `claimDeposit`)
- `packages/signet-contract/src/signet-contract.compact` (deletion target; its
  post-semantics comments document the properties the event world must not lose)
- SGN1 spec §"Transport" (guaranteed-segment rule), §"Respond semantics"

---

## Phase 4 — Client stack: `lib` / `cli` / `integration-tests`

### Tasks

- [ ] `lib/midnight-providers.ts`: expose the indexer event surface
      (`contractEventsObservable` with `{ startAt: { fromId } }` resumption /
      `getAllContractEvents` for scans; dedupe by `id` — delivery is
      at-least-once).
- [ ] **Verify the pinned indexer decodes `Misc`**: midnight-js v5.0.0 notes flag
      Misc emit→indexer e2e as skipped pending **midnight-indexer#1279**; the SGN1
      spec pins a `contract-events-e2e` indexer line. Pin the exact
      node + indexer versions in `midnight-node-config.ts` and the
      integration-tests preflight.
- [ ] Replace polling commands:
  - [ ] `poll-signature-response.ts` → tail `RESP` events for a request id,
        verify each candidate signature off-chain
        (`signature-response-verification`), return the genuine one;
  - [ ] `poll-respond-bidirectional.ts` → tail `RESPBI` parts, reassemble,
        verify attestation off-chain before handing to claim.
- [ ] Rewire `request-deposit.ts` (request id now computed via the tails-hash
      circuit / recomputed locally), `claim-deposit.ts` (supply request contents +
      attestation as args), `deposit-e2e.ts`, `broadcast-evm.ts` (unchanged in
      principle — signature attach + broadcast), `read-state.ts` (ledger reads
      shrink to nonce + claimed-set; add an events-dump mode).
- [ ] Implement withdraw commands (`request-withdraw`, `refund-withdraw`,
      `withdraw-e2e`) against the event transport (un-stub `NotImplementedError`).
- [ ] `integration-tests`: preflight checks for indexer event support; e2e:
      deposit request → fakenet signer consumes events → respond events → claim.

### Milestone 4

Deposit e2e green against a local node + Misc-decoding indexer with a fakenet
MPC signer driven purely by the event stream (no ledger polling anywhere).

### References

- `packages/lib/src/midnight-providers.ts`, `midnight-node-config.ts`
- `packages/cli/src/commands/*` (all listed above)
- midnight-js `indexer-public-data-provider` README (contract events, cursors, dedupe)
- midnight-indexer#1279 (Misc decode fix — availability gate)
- Old repo Sepolia runbook + fakenet signer (recent `midnight-erc20-vault` e2e work) for the e2e shape

---

## Phase 5 — Cross-repo convergence & cutover

### Tasks

- [ ] **Signer contract unification**: decide the fate of the colleague's
      standalone `signet-signer.compact` — remains the MPC-team dev vehicle
      consuming shared structs from `signet-midnight`, or is superseded by the
      requester contracts here. Either way it imports the shared module instead of
      redefining structs.
- [ ] **MPC (Rust) consumer**: exchange final golden vectors; run the MPC's
      chain-midnight indexer against events emitted by this repo's contracts.
- [ ] **solana-signet-program response-server**: it depends on `signet-midnight` +
      `signet-contract`; `signet-contract` is deleted in Phase 3 — migrate the
      response-server to the event API (respond circuits + event codec) and update
      its allowed-dependency boundary accordingly.
- [ ] Docs: replace the "Signet Contract Ledger Layout" / polling documentation in
      `Signet.compact` headers and `repo-layout.md`; promote the frozen wire spec
      into this repo as the normative doc; update the `README.md` porting banner.
- [ ] Delete stale artifacts: central-contract deploy tooling, polling CLI docs,
      superseded goldens.
- [ ] Merge plan: refactor branch → `main` of `midnight-erc20-vault` per the
      porting convention (ported-with-tests, stale parts stripped).

### Milestone 5

Both repos (this + solana-signet-program) and the MPC consumer build against one
wire spec and one `signet-midnight` package; refactor branch merged to main;
`SGN1`-era prototype spec superseded or formally adopted.

### References

- Dependency boundary: solana-signet-program response-server → signet-midnight (+ formerly signet-contract)
- `midnight-erc20-vault/repo-layout.md` (design doc for the port)

---

## Standing risks (track across phases)

| Risk | Phase it bites | Mitigation |
|---|---|---|
| Indexer `Misc` decode fix (midnight-indexer#1279) not in a released line | 4 | Pin the `contract-events-e2e` indexer build the signer team already uses; verify in preflight |
| MPC won't implement the Jubjub Schnorr attestation | 0 / 3 | Escalate at the alignment meeting — without it there is no trustless `claimDeposit`; fallback designs (optimistic claim, oracle relay) are a scope change, not a tweak |
| compactc 0.33 / runtime 0.18 are RC-grade | 1 | Isolated toolchain PR; keep the ledger-state branch green until Milestone 2 |
| Package-identity (Symbol/global) breakage after the bump | 1 | Re-apply the symlink discipline across all `@midnight-ntwrk` consumers including the solana tree |
| Spec drift while phases 1–2 run | 2+ | Golden vectors are the contract: any change regenerates vectors and bumps the wire tag |
