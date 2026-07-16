# Caller attribution & cross-contract request emission (the MPC / signet flow)

Back to [`index.md`](index.md) · related: [`authenticity-and-signing.md`](authenticity-and-signing.md), [`cross-contract-calls.md`](cross-contract-calls.md), [`gotchas.md`](gotchas.md)

> **Status: design reasoning, not yet built.** This captures the analysis behind a planned
> change — routing the ERC20 vault's deposit/claim signature *requests* through a **new
> `requestSignature` method on the signet contract** via a cross-contract call, so the signet
> contract emits the request event and the MPC watches **one** contract instead of scanning
> each requester's ledger. It exists because the naive version of that design has a
> **theft-grade security hole** rooted in a Midnight-specific fact. Read before implementing.
>
> Two claims below are **verified** (event provenance is unforgeable; a contract can't see its
> caller — see [`authenticity-and-signing.md`](authenticity-and-signing.md), [gotcha #19](gotchas.md#19)).
> One is **unverified / open** and flagged as such: whether the MPC can practically parse the
> Midnight transaction call-tree to attribute a cross-contract caller (Option 1).

## The rule that decides everything

On Midnight, **an event's provenance is unforgeable, but a `sender`/`caller` field *inside* the
event is not.** A contract **cannot see its caller in-circuit** — `kernel.self()` returns its
*own* address; there is no `caller()` / `msg.sender`. So when contract B emits
`Event { sender, … }`, two different things hold:

- ✅ "B emitted this event" — unforgeable (ZK proof + on-chain verifier key).
- ❌ "sender = X" — only as trustworthy as whoever set it; B copied it from a call argument it
  **cannot verify**. Any caller can pass any value.

### Why the intuition misleads (inverse of EVM / Solana / NEAR)

On those chains the runtime enforces the caller identity (`msg.sender`, Solana `Signer`, NEAR
`predecessor_account_id`), so "emit the sender" *is* trustworthy — it's the standard pattern.
On Midnight, contract-to-contract caller identity is **not available in-circuit**, so the same
pattern is silently insecure. Do not port "emit msg.sender" thinking to Midnight.

(See the Solana MPC contract `chain-signatures/contract-sol/src/lib.rs` + indexer
`chain-signatures/chain-solana/src/indexer.rs` in the `sig-net/mpc` repo: it relies on
`emit_cpi!` and an **inner-instruction `program_id ==` check**, plus `Signer` accounts, exactly
because a bare log field wouldn't be trustworthy. Midnight needs the analogous work — but for
*caller* attribution, not *emitter* attribution.)

## Why this is theft-grade for the signet/MPC flow specifically

The MPC derives the signing key as **`f(requester_contract_address, path)`** (epsilon
derivation). In this repo:
`EVM_VAULT_ADDRESS = deriveEvmAddress(mpcPk, MIDNIGHT_VAULT_CONTRACT_ADDRESS, "vault")` and
`EVM_USER_ADDRESS = deriveEvmAddress(mpcPk, MIDNIGHT_VAULT_CONTRACT_ADDRESS, userCommitment)`
(`@sig-net/midnight`; used in `integration-tests/tests/e2e.test.ts`). **The
requester contract address is a derivation input.**

If the MPC keyed off a `sender` field in a signet-emitted event, a malicious contract `M` could:

```
signet.requestSignature(sender = VAULT_ADDR, path = victimCommitment, evmTx = drain-to-attacker)
```

signet emits a *genuine* event (`sender = VAULT_ADDR`); the MPC derives the victim's key and
signs the drain transaction. An unverifiable event field **cannot** be allowed to drive key
selection or authorization.

## What today's "index in the caller" buys you for free

Current design (no cross-contract call): the vault stores each request in **its own** ledger at
field 0, and the MPC reads it straight from the vault's contract state
(`SIGNET_REQUESTS_INDEX_FIELD = 0`, `packages/signet-midnight/src/signature-requests-state-reader.ts`;
layout declared in each requester contract, e.g. `packages/caller-contract/src/signet-caller.compact` — `signetRequestsIndex`
field 0, `signetNonce` field 1). This gives, **for free and unforgeably**:

1. **Requester attribution** — "requester = vault" is guaranteed by *whose authenticated state
   the MPC read*. This is the epsilon-derivation predecessor.
2. **Two circuit-enforced gates the MPC can therefore trust**, both in the vault's proven
   circuit (`erc20-vault.compact`):
   - `witness callerSecretKey()` + `path == canonical-hex(userCommitment)` — only the
     secret-holder can request *their* path (`deposit`; re-checked in `claim` via
     `assertHexOf(caller, signatureRequest.path)`).
   - the EVM transaction is **constrained** (recipient = the vault's EVM address, a transfer) —
     the vault decides what may be signed.

Moving emission into signet **removes attribution #1** (signet can't see its caller) and makes
`requestSignature` **permissionless** — anyone can call it with any params, so #2's gates mean
nothing unless the MPC can confirm a *trusted* contract ran them.

## Options to re-establish attribution

Pick based on whether the MPC's behaviour depends on the caller identity. In this flow it does
(derivation root = requester address), so attribution is **security-critical**, not cosmetic.

### Option 1 — verify the transaction call-tree (Midnight analogue of Solana `emit_cpi!`)
MPC **discovers** via signet's events (one subscription), then **confirms** from the *same
transaction* that the call into `signet.requestSignature` came from an authorized requester: the
vault's own proven contract call is present in the tx, and its `claimedContractCalls` effect
links to signet via the communication commitment. The `sender` field becomes trustworthy
because it's cross-checked against tx structure — never taken on faith. Requires a requester
allow-list (you already have `MIDNIGHT_CONTRACT_ADDRESSES`).
- **Best fit for "MPC watches one contract"** and directly mirrors the Solana validator.
- ⚠️ **OPEN / UNVERIFIED:** I have not confirmed how readily the MPC can parse the Midnight
  transaction call-tree (contract calls + `claimedContractCalls` effects) off the indexer, the
  way the Solana indexer parses `inner_instructions`. **Verify this is practical before
  committing to Option 1.** If it isn't cheap, prefer Option 3.

### Option 2 — return-id + two-set binding
`signet.requestSignature` returns a `requestId` (bound by the communication commitment); the
vault records it in its own ledger. MPC discovers via signet's event, confirms
`requestId ∈ vault.requests`. This is the token/vault proof pattern from
[`authenticity-and-signing.md`](authenticity-and-signing.md) § 3 applied here.
- Sound, and reuses a verified mechanism. Downside: a per-requester **read** (targeted
  membership check, not the full scan you have today) — partially dilutes centralization.

### Option 3 — index-as-source, event-as-notification (smallest change)
Keep the vault's field-0 index as the authoritative, attributed source (exactly as today). Add
the signet event purely as a **central notification/ping**: the MPC subscribes to signet to
know *when* to act, then reads the actual request from the requester's authenticated state.
- Smallest security delta, keeps all of today's guarantees, still gains a central wake signal.
- Doesn't remove per-requester reads, but removes per-requester *polling*.

## The derivation-root reframe (considered, not recommended)
If the derivation root were `signet_contract_address` (not per-vault), the requester-contract
identity would stop being a derivation input, so a `sender` field couldn't drive key selection.
But you'd lose the per-vault EVM account model **and** the "vault constrains the EVM tx"
guarantee (signet can't run vault-specific logic), pushing *all* authorization onto the
user-secret gate + whatever constrains the tx. Bigger redesign, generally worse for the threat
model. Keep `f(requester, path)` and solve attribution via Option 1 or 3.

## Additional facts for the build

- **signet cannot gate its caller**, so `requestSignature` is inherently permissionless. Its
  circuit *can* still enforce user-secret gates (`callerSecretKey`) and can constrain/echo the
  request, but it cannot restrict *which contract* calls it. Requester restriction must come
  from the MPC side (allow-list + attribution) or from the requester recording proof of its own
  involvement (Option 2).
- Today the signet contract only handles **responses** (`postSignatureResponse`,
  `postRespondBidirectional`, verifying the MPC attestation with `jubjubSchnorrVerify` —
  `packages/signet-contract/src/signet-contract.compact`). Adding `requestSignature` makes it
  both request-emitter and response-sink; fine, but it's a real role change.
- The MPC **response** is authenticated the opposite way from requests: the MPC signs, and the
  signet contract *verifies* that Schnorr signature in-circuit. Contracts verify signatures;
  they don't produce them (see [`authenticity-and-signing.md`](authenticity-and-signing.md) § 2, § 5).

## TL;DR

- "Events can't be forged" is true about **provenance**, false about a **caller field** — a
  Midnight contract has no `msg.sender`.
- Your key derivation uses the requester address, so a forged `sender` = key theft. A signet
  event field alone is **not** sufficient authorization.
- To centralize on signet safely, re-establish attribution: **tx call-tree check** (Option 1,
  verify feasibility first), **return-id two-set** (Option 2), or **index-as-source +
  event-as-ping** (Option 3). The per-requester index you have today is giving you that
  attribution for free — don't discard it without a replacement.
