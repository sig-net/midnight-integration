# Gotchas & non-obvious bugs

Back to [`index.md`](index.md). **Read this before writing code.** Every item was hit during
the research behind `packages/xcontract-events`. Each has an explicit anchor (`#1`, `#2`, …)
that other KB files link to.

Severity legend: 🔴 will block you / silently wrong · 🟡 confusing but recoverable · ⚪ noise.

---

<a id="1"></a>
## 1. 🔴 You cannot declare your own `event` type

The `event` keyword is **reserved for future use** in compactc 0.33. Any of
`event E {…}`, `export event E {…}`, `export event struct E {…}` →
`parse error: found keyword "event" (which is reserved for future use)`.

**Do this instead:** emit a canonical `CompactStandardLibrary` event. For app-defined events
use `Misc { name, payload }` with a `serialize<T,256>` payload. See [`events.md`](events.md).

<a id="2"></a>
## 2. 🔴 `emit` rejects a plain user struct

`emit (MyStruct { … })` where `MyStruct` is an ordinary `struct` →
`struct MyStruct<...> is not a declared event type`. Only the 11 stdlib event types are
emittable. Wrap your struct in `Misc.payload` via `serialize` (#1, [`events.md`](events.md)).

<a id="3"></a>
## 3. 🔴 Must `compile:zk` before deploying or proving

The default `compact compile --skip-zk` produces **no `keys/` and `expectedVk = {}`**. Deploy
(`buildDeployTransaction`) and any circuit-call proof need the verifier/prover keys. Symptom
if you skip it: deploy or `/check` fails to find keys. Run `yarn compile:zk` (full compile)
first. See [`toolchain.md`](toolchain.md).

<a id="4"></a>
## 4. 🔴 ledger-v9 1.0.0-rc.3 requires a `lookupKey` on the proving provider

The proof provider must expose `lookupKey(keyLocation)` or ledger-v9 rc.3 throws *"expected
proving provider property 'lookupKey' to be a function"* on every circuit-call proof.
midnight-js's own `httpClientProvingProvider` (built against an earlier rc) returns only
`check`/`prove`. Both lib proof-provider helpers graft `lookupKey` on. If you build a proof
provider from scratch, do the same. See
[`../../lib/src/midnight-providers.ts`](../../lib/src/midnight-providers.ts) (the comment on
`createProofServerProvider`) and [`cross-contract-calls.md`](cross-contract-calls.md).

<a id="5"></a>
## 5. 🟡 Emitted events are NOT observable in the in-process simulator

`@midnight-ntwrk/compact-runtime` runs circuits locally, but the query context that holds the
public transcript (where `emit` writes) is an **opaque WASM handle** (`{ __wbg_ptr }`). You
can't read the event back offline. Offline you can only assert the emit *ran* (ledger
mutated) + *compiled* (`'log'` in generated JS) + payload *round-trips* (pure encode circuit).
Event **delivery** is only observable on a live node via the indexer (#13,
[`events.md`](events.md) § "Reading events back").

<a id="6"></a>
## 6. 🔴 Contract-reference plumbing has two surprising shapes

- The **constructor argument** for a contract-typed field is `{ bytes: Uint8Array(32) }`, NOT
  a hex string. Convert: `{ bytes: Uint8Array.from(Buffer.from(stripHex(addrHex), "hex")) }`.
  Passing the hex string → `expected value of type contract Token[...] but received '…'`.
  Helper: `contractAddressToReference` in [`src/deploy.ts`](../src/deploy.ts).
- `contractDependencies(locations, state)` wants a raw **`StateValue`**, which is
  `currentContractState.data.state` — you must **unwrap the `ChargedState`** (`.data` is a
  `ChargedState`, `.data.state` is the `StateValue`). Passing `.data` →
  `state.asArray is not a function`.

<a id="7"></a>
## 7. 🔴 THE BIG ONE — the proof provider must span EVERY contract in the call tree

Proving a cross-contract call resolves ZK keys for the caller **and** each callee via a
`ZKConfigRegistry`. lib's default `createProofServerProvider(url, oneProvider)` registers one
contract. Use it for a cross-contract caller and proving dies at `/check` with:

```
ZKArtifactNotFoundError: No ZK artifact bundle matches the deployed verifier key
for contract '<callee>', circuit '<circuit>'. The local compiled artifacts are missing
or stale with respect to the deployed contract.
```

**The message is a red herring** — the artifacts are usually correct (verified: local
`.verifier` hash == on-chain `ContractOperation.verifierKey` hash). The real cause: the base
`httpClientProvingProvider`'s key resolver was handed only the caller's provider, so `/check`
can't resolve the **callee's** verifier key. `makeKeyMaterialResolver`
(`@midnight-ntwrk/midnight-js-http-client-proof-provider` index.mjs:45-63) special-cases a
`ZKConfigRegistry` argument, so the fix is to pass a registry over **all** contracts into it.

**Fix:** use `createCrossContractProofServerProvider(url, [callerZk, ...calleeZks])` (added in
[`../../lib/src/midnight-providers.ts`](../../lib/src/midnight-providers.ts)); wired in
[`src/providers.ts`](../src/providers.ts). Full analysis in
[`cross-contract-calls.md`](cross-contract-calls.md) § "multi-contract proof provider".

<a id="8"></a>
## 8. 🟡 `Cell` is not a bare identifier; a plain-typed ledger field IS the cell

`ledger x: Cell<Uint<128>>;` → `unbound identifier Cell`. Declare a scalar ledger field with
its plain type — `ledger lastAmount: Uint<128>;` — and assign with `=`
(`lastAmount = disclose(v);`), not `.write()`. (`Counter`, `Map`, `Set`, etc. ARE named ADT
types with methods; scalar cells are not.)

<a id="9"></a>
## 9. 🔴 `disclose()` is mandatory when a param/witness value reaches public state

Writing a circuit parameter or witness-derived value into ledger state, OR emitting it in an
event, is a "disclosure" and must be wrapped: `token = disclose(t);`,
`lastAmount = disclose(amount);`, `emit(Misc { …, payload: disclose(serialize<…>(…)) })`.
Omitting it → `potential witness-value disclosure must be declared but is not`.

<a id="10"></a>
## 10. 🟡 `Counter.increment(n)` takes `Uint<16>`

`someCounter.increment(amount)` where `amount: Uint<128>` →
`expected first argument of increment to have type Uint<16> but received Uint<128>`. The
argument width is fixed at `Uint<16>` regardless of what you're counting. Use
`.increment(1)` or cast/track the real amount in a separate field.

<a id="11"></a>
## 11. 🟡 The integration test's `sequence == 0` assertion assumes a fresh token

[`tests/integrationTest.test.ts`](../tests/integrationTest.test.ts) deploys a fresh token per
run, so the first (only) deposit has `sequence == 0`. If you **resume** against a kept
`XC_TOKEN_CONTRACT_ADDRESS`, `depositCount` (and thus `sequence`) will be > 0 and there will
be multiple `Misc("deposit")` events. Relax to "an event with `amount == 4242` exists" for
resume-safety.

<a id="12"></a>
## 12. ⚪ `indexerPublicDataProvider(queryURL, subURL)` positional form is deprecated

Use the object form: `indexerPublicDataProvider({ queryURL, subscriptionURL })`. (The repo's
older provider files still use the positional form; harmless but deprecation-warned.)

<a id="13"></a>
## 13. 🟡 Event field quirks when reading off the indexer

- `ContractEvent.name` and `.payload` (for `Misc`) come back **hex-encoded strings** — decode
  with `Buffer.from(hex, "hex")` before use; may or may not carry a `0x` prefix (strip it).
- `ContractEvent.transactionId` is the **indexer's internal BIGSERIAL row id, NOT the chain
  transaction hash**. To narrow by chain tx, use the filter's `transactionHash` instead.
- `ContractEvent.id` is the monotonic event cursor (resume after via `fromId: id + 1`);
  `raw` is the opaque `VersionedLogItem` hex.
- Empty `types: []` in a filter is **rejected** (it would match nothing) — omit `types` to
  mean "all".

<a id="14"></a>
## 14. 🟡 External contract circuit declarations need the `circuit` keyword

`contract Token { deposit(amount: Uint<128>): []; }` →
`parse error: found "deposit" looking for an external contract circuit or "}"`. Write
`contract Token { circuit deposit(amount: Uint<128>): []; }`.

<a id="15"></a>
## 15. 🟡 Event indexing lags block finalization — poll

After `callTx` resolves (tx finalized on chain), the event may not be queryable for a second
or two. Poll `queryContractEvents` until it appears (the integration test polls up to 60s @
1s). Don't assert immediately after the call returns.

<a id="16"></a>
## 16. 🔴 The indexer image must be a "contract-events" build

A stock ledger-8-era indexer does not decode MIP-0002 `Misc` events. The repo's
[`docker-compose.yaml`](../../../docker-compose.yaml) pins a specific
`indexer-standalone:4.4.0-pre-alpha.16-…contract-zswap…` build that does (its comment cites
midnight-indexer#1279). If events never show up on a stack that otherwise works, check the
indexer tag.

<a id="17"></a>
## 17. ⚪ Harmless log noise

- `RPC-CORE: subscribeRuntimeVersion(): … disconnected … 1000:: Normal Closure` during deploy
  — wallet-facade reconnect chatter.
- `Sourcemap for ".../managed/.../index.js" points to missing source files` — generated JS
  references the `.compact` path; ignore.

<a id="18"></a>
## 18. 🔴 You cannot export a generic (type-parameterized) circuit

`export circuit deposit<T>(amount: Uint<128>, params: T): []` →
`cannot export type-parameterized function (deposit) from the top level`. Generics work
*inside* a contract (generic structs, non-exported generic circuits, generic modules
specialized on import, `serialize<Ev<Bytes<32>>,256>`) but the **exported boundary must be
monomorphic**. Also: a type param that gets `serialize`d must be statically sized —
`Opaque<"string">` → *"opaque is not serializable"*. To carry "arbitrary caller params",
monomorphize at the boundary (exported circuit takes a concrete `Bytes<N>`) and keep the
genericity in TS. Full detail + the compile matrix: [`generics.md`](generics.md).

<a id="19"></a>
## 19. 🔴 `ownPublicKey()` is a witness — never use it to verify a caller

`ownPublicKey()` is technically a *witness*; each user's frontend can return a malicious value,
so it is **not** a trustworthy caller identity. Authenticate callers with the hash-based
"DApp public key" pattern (`persistentHash([pad(32,"…"), sk])` stored as an authority and
re-verified) instead. Only use `ownPublicKey()` after the caller is otherwise verified. See
[`authenticity-and-signing.md`](authenticity-and-signing.md) § 4.

<a id="20"></a>
## 20. 🟡 Contracts can't sign; events aren't signed — they're proof-authenticated

Don't look for a contract private key / PDA-style signing to "prove" an event. There isn't
one (the only contract key is the governance **maintenance authority**, not for signing
outputs). Event/return authenticity comes from the ZK **proof + on-chain verifier key**, and
cross-contract results are bound by the **communication commitment**. Contracts *verify*
signatures (`jubjubSchnorrVerify`) from external signers; they don't produce them. Full model:
[`authenticity-and-signing.md`](authenticity-and-signing.md).

<a id="21"></a>
## 21. 🔴 An event's `sender`/`caller` field is NOT trustworthy (no `msg.sender`)

Emitting `Event { sender, … }` where the contract set `sender` from a call argument proves
nothing about who actually called — a Midnight contract can't see its caller ([#19](gotchas.md#19)),
so any caller can pass any value. The event's *provenance* (which contract emitted it) is
unforgeable; a *field inside it* is not. This is the **inverse of EVM/Solana/NEAR**, where the
runtime enforces the caller, so "emit `msg.sender`" is safe there and unsafe here. If anything
security-critical keys off the caller (e.g. an MPC deriving a signing key from the requester
address), a forged `sender` is a theft vector — re-establish attribution via authenticated
state or the tx call-tree. Full analysis: [`caller-attribution.md`](caller-attribution.md).

<a id="22"></a>
## 22. 🔴 `serialize<T,N>()` can't lower a `new type` field — compiler crash

A struct field whose type is a `new type` alias (e.g. `new type RequestId = Bytes<32>`)
crashes the compiler when that struct is passed to the `serialize<T,N>` event-payload encoder:

```
Internal error (please report): Exception in build-serialize: … unhandled type
#[#{Lnoserialize:talias:…} … RequestId #[#{Lnoserialize:tbytes:…} … 32]]
```

The `build-serialize` pass (`analysis-passes.ss:6087`) has cases for `struct`/`Bytes`/`Uint`/
`enum`/`Vector` but **none for a nominal alias node** (`talias`), so it throws instead of
resolving the alias to its representation type. The asymmetry that makes this confusing:
**ledger-state serialization resolves `new type`s fine** — the same `RequestId` works as a
`Map` key and as a ledger-written struct field — so only the explicit `serialize<>` builtin
(the `Misc.payload` path, [`events.md`](events.md)) chokes.

**Fix:** in the struct you `serialize`, declare the field as the **representation type**
(`requestId: Bytes<32>`, not `RequestId`) and cast at construction
(`requestId: disclose(requestId) as Bytes<32>`). The `new type` is a compile-time-only
distinction, so nothing is lost on the wire; keep it everywhere else (circuit params, ledger
keys) for the nominal safety. Real instance: `SignBidirectionalEventNotification` in
`packages/signet-contract/src/signet-contract.compact`. Same monomorphize-at-the-boundary
shape as [#18](gotchas.md#18).

---

## Meta-gotcha: docs describe an aspirational language

Architecture proposals 0010/0011 and parts of the Compact reference describe `interface`
types, multiple deployable `contract {}` blocks per file, `[T]` generic brackets, and dynamic
instantiation. compactc 0.33 implements only a **subset**. Do not assume a documented feature
compiles — **probe it** (see [`toolchain.md`](toolchain.md) § "Probe the compiler") or search
live docs with the `mcp__midnight-docs__search_midnight_knowledge_sources` MCP tool.
