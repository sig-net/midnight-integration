# Event authenticity, contract "signing", and the trusted cross-contract return

Back to [`index.md`](index.md) · related: [`events.md`](events.md), [`cross-contract-calls.md`](cross-contract-calls.md), [`gotchas.md`](gotchas.md)

> **The question this answers:** a chain observer sees an event from contract B. How does it
> know the event is legitimate and not forged by a malicious node/indexer? And in the flow
> **A → calls → B, B emits an event, B returns something to A** — how is A (and any verifier)
> sure the event wasn't forged?
>
> **Short answer:** you don't sign events. On Midnight, authenticity comes from the **ZK proof
> + on-chain verifier key**, not a signature. Events are part of the proven transcript; the
> cross-contract **communication commitment** binds B's return value into A's proof; and you
> can additionally mirror events into **authenticated ledger state**. Contracts have **no
> PDA-style signing key**. Details + the verified mechanism below.

## 1. Events are already protocol-authenticated (no signature needed)

Every contract call is `{ address, entry_point, transcript, communication_commitment, proof }`
(ledger spec `contracts.md`). The `emit` statement compiles to a `log` op inside the
**public transcript** (see [`events.md`](events.md) § "how emit lowers"), and:

- The **shape of the transcript is enforced by the circuit** (Midnight docs, *Transcripts and
  ZK Snarks*: "the shape of this bytecode is directly enforced by the circuit").
- A transaction is *"essentially made up of the public transcript and a zero-knowledge proof
  that this transcript is correct"*, verified on-chain against the **verifier key stored per
  `(contract address, entry point)`**.
- The ledger records the event as `EventDetails::ContractLog { address, entry_point,
  logged_item }` (midnight-ledger `events.rs`), produced in `apply_actions` (`semantics.rs`)
  only from a call whose proof verified.

**Consequence:** a malicious **node** cannot forge an event. To make an event appear, it would
have to produce a valid SNARK for the contract's circuit whose enforced transcript contains
that `log` op — i.e. forge a proof, which the ZK system makes infeasible. An event in a
finalized transaction is cryptographically guaranteed to come from a genuine execution of that
contract's circuit, attributed to that contract address.

**Trust boundary = the block, not the indexer.** A malicious **indexer** (which just serves
data to a light client) *can* lie. Mitigate the usual way: the event is bound into a
consensus-finalized block; verify against a trusted node / multiple sources. The event's
*content authenticity* ("this contract really emitted this") holds once you trust the block is
canonical. (The `ContractEvent.raw` field — opaque `VersionedLogItem` bytes — is the forward
bridge for client-side re-derivation.) See also §4 for a way to sidestep indexer trust
entirely.

## 2. Contracts do NOT have a signing key (no Solana-PDA equivalent)

- There is **no per-call contract signing** of arbitrary messages/events. A contract's
  authority *is* its ZK proof, not a signature.
- The only contract-associated key is the **maintenance authority** signing key
  (BIP-340 Schnorr *or* ECDSA — `sampleSigningKey('schnorr'|'ecdsa')`), used solely for
  **governance**: replace authority, insert/remove verifier keys (midnight-js
  `find-deployed-contract.ts`, `submitInsertVerifierKeyTx`, etc.). It does **not** sign
  call outputs or events. The runtime's `signData` even warns *"Do not expose access to this
  function for valuable keys…"*.
- So "can the contract sign for something like a PDA?" → **No.** The equivalent guarantee is
  achieved by the proof (§1) and the communication commitment (§3), not a signature.

## 3. THE flow — A calls B, B emits + returns, A (and verifiers) can't be fooled

Two mechanisms, both **verified**. Use them together.

### 3a. The communication commitment binds B's return value to A's proof

Cross-contract calls carry a `communication_commitment` — a Poseidon commitment to the
callee's **inputs AND outputs**:

- Constructed as `transient_commit(input ‖ output, rand)` (midnight-ledger `construct.rs`
  `add_call`).
- It is the callee's **second public input by convention** and is recomputed in-circuit as
  `poseidon(comm_rand ‖ inputs ‖ outputs)` (midnight-ledger `zkir-v3/ir_vm.rs`).
- The **caller** recomputes the *same* commitment in its own circuit (shared randomness) and
  declares a `claimedContractCalls` effect `[seq, calleeAddr, entryPointHash, comm]`
  (onchain-runtime `Effects`). The ledger links caller→callee by matching
  `addr && communication_commitment && entry_point hash` (`construct.rs` `references()`).
- Both proofs live in the **same transaction**, bound atomically by the Pedersen binding
  commitment (docs, *Transaction integrity*).

**Therefore:** a malicious node cannot forge B's return value or substitute a different
execution. A's proof only verifies if the `(args, return)` it bound matches the commitment in
B's proof; B's proof only verifies if B genuinely executed its circuit producing that return.
So **if B returns a commitment to the event it emitted, A's proof cryptographically binds that
event.** Combined with B's own proof binding the `emit` into B's transcript, A — and anyone
verifying the transaction — is assured B emitted an event with exactly that content, in that
transaction.

**Cross-contract calls returning values is supported (VERIFIED compiling, compactc 0.33):**

```compact
// Contract B (callee) — returns a commitment to the event it just emitted.
export circuit deposit(amount: Uint<128>): Bytes<32> {
  const sequence = depositCount as Uint<64>;
  depositCount.increment(1);
  const payload   = serialize<DepositEvent, 256>(DepositEvent { amount: disclose(amount), sequence: sequence });
  const eventHash = persistentHash<Bytes<256>>(payload);
  emit (Misc { name: pad(32, "deposit"), payload: disclose(payload) });
  return disclose(eventHash);                     // ← returned to the caller
}

// Contract A (caller) — captures B's returned event commitment.
contract Token { circuit deposit(amount: Uint<128>): Bytes<32>; }
export sealed ledger token: Token;
export ledger lastEventHash: Bytes<32>;
constructor(t: Token) { token = disclose(t); }
export circuit depositViaVault(amount: Uint<128>): Bytes<32> {
  const eventHash = token.deposit(disclose(amount));   // cross-contract call WITH return value
  lastEventHash = disclose(eventHash);                 // A commits to B's event, in A's proven state
  return disclose(eventHash);
}
```

Generated A signature: `depositViaVault(...): Promise<CircuitResults<PS, Uint8Array>>` — the
`Bytes<32>` return crosses the boundary as `Uint8Array`. (The main package's contracts return
`[]`; this returning variant is the scratch experiment behind this section.)

### 3b. Mirror events into authenticated ledger state (trustless of the indexer)

Because **ledger writes are also part of the proven transcript**, B can keep an on-chain
accumulator of emitted-event hashes:

```compact
export ledger emittedHashes: Set<Bytes<32>>;    // VERIFIED compiling
// inside deposit:
emittedHashes.insert(disclose(eventHash));
```

Now an observer verifies an event **without trusting the indexer's event stream at all**: hash
the event payload and check membership in B's on-chain `emittedHashes` (public, proven state,
read via `publicDataProvider.queryContractState`). This reduces event verification to an
authenticated public-state lookup. (`Set`/`Map`/`List`/`MerkleTree` are all available ledger
ADTs; a `MerkleTree` accumulator additionally lets you prove membership succinctly.)

> **Applying this to a shared request contract (vault → signet → MPC):** the same "callee
> can't see its caller" fact means a `sender` field in an event emitted by a *shared* contract
> is forgeable, which is a theft vector when an MPC derives keys from the requester identity.
> That design analysis lives in [`caller-attribution.md`](caller-attribution.md).

## 4. Where a caller commitment fits

- A can pass its own **identity commitment** as an argument to B. The communication commitment
  (§3a) binds that argument, so B provably received exactly that identity — B can emit it in
  the event and fold it into the returned hash. This authenticates *who triggered* the event.
- Identity/auth in Compact is **hash-based**, not signature-based: the "DApp-specific public
  key" pattern `publicKey(sk) = persistentHash<Vector<2,Bytes<32>>>([pad(32,"…"), sk])`, stored
  as an authority and verified by recomputation (Midnight *smart-contract-security* docs; the
  vault contract's `userCommitment` is exactly this). Add a round counter to break
  linkability across a call chain.
- ⚠️ **Never use `ownPublicKey()` to verify a caller** — it is a *witness* (each frontend can
  return a malicious value). Only use it after the caller is otherwise verified. See
  [gotcha #19](gotchas.md#19).

## 5. Built-in crypto available in Compact circuits (compactc 0.33)

All confirmed present (stdlib builtins / used in this repo or the zk-loan tutorial):

| Primitive | Symbol(s) | Use |
|---|---|---|
| Embedded curve (JubJub) | `JubjubPoint`, `ecMulGenerator(scalar)`, `ecMul(point, scalar)`, `jubjubPointX/Y`, `hashToCurve<T>(rt, x)` | curve ops, key derivation |
| Schnorr over JubJub | `jubjubSchnorrVerify<N>(msg, JubjubSchnorrSignature { announcement, response })`, `schnorrChallenge` | **verify** external signatures in-circuit |
| Hashing / commitments | `persistentHash<T>(x)`, `transientHash<T>(x)`, `transient_commit` (Poseidon) | commitments, event/ledger hashing |
| Caller identity | hash-based `publicKey(sk)` pattern; `ownPublicKey()` = **witness, untrusted** | auth without revealing keys |

Real usage: [`packages/signet-contract/src/signet-contract.compact`](../../signet-contract/src/signet-contract.compact)
verifies MPC attestations with `jubjubSchnorrVerify<4>(...)` against a `persistentHash<JubjubPoint>`
pinned at deploy — i.e. a contract **verifying** an external signer's signature. That's the
idiom: contracts *verify* signatures (from off-chain signers / MPC), they don't *produce* them.

## TL;DR decision guide

- "Is this event real?" → it's in a finalized tx whose proof verified against the contract's
  verifier key. Trust the block (§1). Don't trust a lone indexer (§1, §3b).
- "A must trust B's event/result across a cross-contract call" → have B **return** a
  commitment to the event; the **communication commitment** binds it into A's proof (§3a).
- "A verifier shouldn't have to trust the indexer" → B mirrors event hashes into a proven
  ledger `Set`/`MerkleTree`; verify by public-state membership (§3b).
- "Can the contract sign like a PDA?" → No; verify signatures with `jubjubSchnorrVerify`,
  authenticate callers with hash commitments, rely on the proof for integrity (§2, §5).
