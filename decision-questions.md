# Questions for the Midnight team — signet MPC signature requests on Midnight

## Who we are / what we're building

We are [sig-net](https://docs.sig.network/) (signet): an MPC network providing chain
signatures. A Midnight contract records a "please sign this EVM transaction" request; our
MPC reads it, signs with a key derived from `f(requesterContractAddress, path)`, and posts
responses back to a central signet contract. Because the **requester contract address is a
key-derivation input**, request attribution is security-critical — a forged "sender" field
would be a theft vector, not a cosmetic bug.

Toolchain we're on: `compactc` 0.33.0 (language 0.25), `compact-runtime` 0.18.0-rc.0,
`midnight-js` 5.0.0-beta.3, `ledger-v9` 1.0.0-rc.3.

## The design we've settled on (and want sanity-checked)

Requests are **stored in the caller contract's own ledger**; a **cross-contract call to a
singleton emits one small event as a notification only**. The caller tells the MPC *where*
its request index lives by ledger field position:

```compact
// Caller contract — signet layout convention: request index at ledger field 0.
// The record is generic in BOTH a type and compile-time counts, e.g.
// EVMType2TxParams<#maxCalldataWords, #maxAccessListEntries, #maxStorageKeysPerEntry>.
export ledger signetRequestsIndex: SignBidirectionalRequestIndex<EVMType2TxParams<2, 0, 0>>;
export ledger signetNonce: SignetNonce;  // field 1: change-detection counter

// After storing the request: notify the MPC via the singleton (cross-contract call).
signetEventEmitter.emitSignBidirectionalEvent(SignBidirectionalEvent {
  kernel.self(),
  requestId as Bytes<32>,
  signBidirectionalRequestsIndexField: 0 as Uint<8>,  // "my index is at ledger field 0"
});
```

The MPC then reads the caller's **raw contract state** (indexer `queryContractState`) by
field position alone — no compiled contract artifacts — and decodes the request record with
hand-maintained type descriptors. Attribution is free: the request came from whichever
contract's authenticated state we read.

We reached this design by elimination and want to confirm the eliminating constraints are
real (Q2, Q3), and that what we now depend on is stable (Q1, Q4).

---

## Q1 — Is ledger-field *position* a stable, supported addressing scheme?

We locate state by declaration-order field index: caller contracts put the request index at
field 0, and the event carries `signBidirectionalRequestsIndexField: Uint<8>` so future
callers can put it elsewhere. The [language reference](https://docs.midnight.network/compact/reference/compact-reference#identifiers-bindings-and-scope)
says a ledger field's "location in the (replicated) public state of a contract never
changes", and [toolchain 0.31.0](https://docs.midnight.network/relnotes/compact/toolchain-0.31.0)
added the ledger layout (`name`/`index`/`storage`/`type`) to `contract-info.json`
"suitable for language agnostic tooling".

1. Is **declaration order → flat field index** a compiler *contract* (stable across future
   `compactc` versions), or an implementation detail that happens to hold today? I.e. if a
   contract is recompiled and redeployed with unchanged ledger declarations, are the indices
   guaranteed identical?
2. Past 16 fields the runtime nests the root array ([`StateValue` `Array(n)`, `n ≤ 16`](https://github.com/midnightntwrk/midnight-ledger/blob/ledger-8/spec/onchain-runtime.md);
   [`PublicLedgerSegments`](https://docs.midnight.network/api-reference/compact-runtime/type-aliases/PublicLedgerSegments)
   describes the nesting). Is the chunking scheme (one level deep, order-preserving flatten)
   specified anywhere we can rely on, or should we treat `contract-info.json`'s `index` as
   the only source of truth for the path to a field?
3. Bottom line: is "contract X's request map is at ledger field N" a value we can safely
   persist and act on long-term (our protocol has callers announce N in an event), or do you
   foresee layout changes (reordering, optimization, sparse layouts) that would break it?

## Q2 — Events: are we right that they can't carry the request itself?

Our request record is dynamic in two dimensions — a generic payload type and generic
compile-time capacities — and easily exceeds 256 bytes (it embeds a decomposed EIP-1559
transaction: `path: Bytes<256>`, two `Bytes<128>` schemas, calldata words, …). Our findings
on compactc 0.33 / midnight-js 5.0.0-beta.3:

- Custom event types can't be declared (`event` keyword reserved); app events are
  `Misc { name: Bytes<32>, payload: Bytes<256> }` — a hard 256-byte payload
  ([v5.0.0 new-features](https://github.com/midnightntwrk/midnight-js/blob/main/docs/releases/v5.0.0/new-features.md);
  the indexer schema types `payload` as "Compact Bytes<256>").
- `serialize<T, N>` needs a statically sized `T`, so "arbitrary caller params" can't ride
  along beyond a fixed `Bytes<N>`.
- Carrying a full request over events would therefore mean splitting it across N `Misc`
  events with N fixed at compile time, plus a reassembly protocol per capacity
  instantiation — which collapses for dynamically sized transaction params.
- We also noticed the testkit e2e `Misc` test is skipped because proving `emitMisc` is the
  suite's heaviest circuit (~5× the next-largest zkir) pending a proof-server fix — so
  event payloads look expensive to prove even at 256 B.

1. Is the 256-byte `Misc` cap (and "no user-defined event types") the long-term model, or
   is there a roadmap for larger / typed / schema'd contract events we should design toward?
2. Do you agree with our conclusion: events as **notification only**, ledger state as the
   **authoritative request record**? Or is there an intended pattern for large structured
   event payloads that we've missed?

## Q3 — Cross-contract calls: monomorphic boundary and caller attribution

We considered the inverse design — callers push the request *into* the singleton via a
cross-contract call — and rejected it on two grounds. Please confirm both.

**(a) No generic circuit surface.** The
[reference](https://docs.midnight.network/compact/reference/compact-reference#top-level-exports)
says exporting a generic circuit is a static error, and we've confirmed
`export circuit f<T>(...)` is rejected by compactc 0.33. So a singleton
`requestSignature(request: SignBidirectionalRequest<T>)` is impossible; the only
monomorphic escape is worst-case fixed buffers (e.g. `Bytes<2048>` calldata) for **every**
caller, inflating every caller's circuit size and proving time. Is that reading correct,
and is there any roadmap (contract interface types, per-caller specialization of a callee,
dynamic sizing) that would change it?

**(b) The callee can't see its caller.** There is no `msg.sender` analogue in-circuit, so
the singleton can't attribute requests itself; a `sender` argument is forgeable. The
alternative would be the MPC re-deriving the caller off-chain from the transaction's call
tree / contract-communications commitment. Is parsing the call structure of a transaction
(which contract called which, bound by the communications commitment) off the node/indexer
a supported, stable thing for an external observer to do — or internal machinery we
shouldn't depend on? Is in-circuit caller identity on any roadmap?

## Q4 — Reading raw ledger state without compiled artifacts: how stable is the encoding?

Since the MPC knows only a contract *address* (any conforming contract may request), it
decodes requests from raw state — `queryContractState(address).data` → walk `StateValue`
nodes by field index → decode the Map's cell with hand-built `CompactType` descriptors
mirroring the Compact structs. Crucially, because the record type is generic in
compile-time capacities, **we recover the capacity instantiation from the cell itself**:

```ts
// The stored record's aligned value has FIXED atoms + capacity-scaled atoms:
//   fixedAtoms + maxCalldataWords + maxAccessListEntries·(2 + maxStorageKeysPerEntry)
// We enumerate (words, entries, keys) splits of the surplus atom count and accept the
// first split whose descriptor decodes the value cleanly (exact consumption, length
// checks, enum range checks).
const variable = atoms.length - REQUEST_FIXED_VALUE_ATOMS;
const record = attempt(variable, 0, 0) ?? enumerateAccessListSplits(variable);
```

Our understanding of the encoding stack: state values are `StateValue`s (Cell/Map/Array/…)
holding [Field-Aligned Binary](https://github.com/midnightntwrk/midnight-ledger/blob/ledger-8/spec/field-aligned-binary.md)
aligned values; a struct is the in-declaration-order concatenation of its fields' atoms;
[ADR-0008](https://github.com/midnightntwrk/midnight-architecture/blob/main/adrs/0008-field-aligned-binary-represenations.md)
adopted FAB precisely so stored data survives proving-system changes, and
[proposal 0014](https://github.com/midnightntwrk/midnight-architecture/blob/main/proposals/0014-snark-upgrade.md)
reiterates that FAB-encoded state is field-independent.

1. Is the **FAB + `StateValue` encoding of ledger state a versioned, stable spec** we can
   implement against (in Rust, inside the MPC, without `compact-runtime`)? Which document is
   normative for the shipped ledger?
2. Is the **lowering of Compact types to aligned values** — struct = fields in declaration
   order; `Vector<n, T>` = n consecutive elements; `Maybe<T>` = is_some atom + value;
   enum = one atom; `Uint`/`Bytes` widths — a stable compiler contract across `compactc`
   versions, or could a future compiler lower the same source to a different atom layout?
3. Is our **capacity-recovery-by-atom-count** trick (above) safe, or fragile in ways we
   should know about? Is there a recommended alternative — e.g. should conforming contracts
   publish their layout (say, the capacities as a sealed ledger field, or their
   `contract-info.json`) rather than have readers infer it?
4. One asymmetry bit us already and makes us wary: ledger-state serialization resolves
   `new type` aliases fine, but the `serialize<T,N>` event-payload builtin crashes the
   compiler on a `new type` field (internal error in `build-serialize`, self-diagnosed
   "please report"). Are the two serialization paths intended to converge?

## Ranked by how much rides on the answer

1. **Q4.2** — if type lowering isn't stable, our whole no-artifacts read path (and any
   Rust reimplementation in the MPC) is built on sand.
2. **Q1** — field-position addressing is the protocol's location scheme; callers announce
   an index and the MPC dereferences it, potentially years later.
3. **Q3b** — determines whether a future singleton-centric design is even possible.
4. **Q2 / Q3a** — confirm the constraints that forced the current design; if either is
   temporary, we may want to design for the future model now.
