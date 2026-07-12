# xcontract-events — spike

Throwaway spike answering: **do this repo's Midnight versions support cross-contract
calls and events?** Short answer: **yes, both.**

> 📚 **Agents / anyone doing cross-contract or event work: start at
> [`knowledge-base/index.md`](knowledge-base/index.md).** It's the comprehensive,
> empirically-verified reference (syntax, deploy/call/read, and every gotcha) distilled from
> this spike. This README is just the spike's own summary.

## Toolchain (what's actually installed)

| Piece | Version | Notes |
|---|---|---|
| `compact` CLI | 0.5.1 | wrapper |
| `compactc` | **0.33.0** | the compiler backing `compact compile` |
| language version | **0.25.0** | max `pragma language_version` supported |
| ledger | ledger-9.1.0.0-rc.2 | |
| runtime | `@midnight-ntwrk/compact-runtime` 0.18.0-rc.0 | |
| SDK | `@midnight-ntwrk/midnight-js` 5.0.0-beta.3 | cross-contract calls land in v5 |

Cross-contract calls are the headline feature of midnight-js **v5.0.0**; events are
**MIP-0002**, needing `compactc 0.33 + compact-runtime 0.18.x`. This repo is on both
lines. `compactc --help` even documents `--no-communications-commitment` (*"omits the
contract communications commitment that enables data integrity for contract-to-contract
calls"*).

## What's here

- [`src/token.compact`](src/token.compact) — **contract B (callee)**. `deposit` bumps a
  counter and emits a **custom event** (`Misc` + a `serialize`d `DepositEvent` struct)
  carrying the `amount` that arrived through the call.
- [`src/vault.compact`](src/vault.compact) — **contract A (caller)**. Declares B's surface
  with an external `contract Token { ... }` block, holds a `sealed ledger token: Token`
  reference, and calls `token.deposit(...)` cross-contract.
- [`src/deploy.ts`](src/deploy.ts) — `deployToken()` then `deployVault(tokenAddress)`
  (order matters: A is constructed with a reference to an already-deployed B).
- [`src/providers.ts`](src/providers.ts) — provider sets + compiled-contract bindings.
  The vault's proof provider spans **both** contracts (see cross-contract note below).
- [`tests/xcontract-events.test.ts`](tests/xcontract-events.test.ts) — **offline** in-process
  simulator confirmation (7 tests).
- [`tests/integrationTest.test.ts`](tests/integrationTest.test.ts) — **live** e2e:
  deploy B → deploy A → call `depositViaVault` → assert B's ledger moved (the
  cross-contract call landed + emitted). Gated by `RUN_INTEGRATION_TESTS`.

```bash
yarn compile        # both contracts, --skip-zk (fast)
yarn compile:zk     # with proving/verifier keys — required to deploy & prove
yarn test               # offline: unit tests run, integration test skips

# live e2e (needs a running node + indexer + proof server, funded DEPLOYER_SEED):
yarn compile:zk
yarn test:integration
```

## How to write each feature

### Custom events (`emit` + `serialize`)

```compact
import CompactStandardLibrary;

struct DepositEvent { amount: Uint<128>; sequence: Uint<64>; }

export circuit deposit(amount: Uint<128>): [] {
  emit (Misc {
    name: pad(32, "deposit"),
    payload: disclose(serialize<DepositEvent, 256>(DepositEvent { amount: amount, sequence: 0 }))
  });
}
```

- Emit with `emit (EventType { ...fields });`.
- **You can't declare your own `event` type yet** — the `event` keyword is still
  *"reserved for future use"* in compactc 0.33, and `emit` rejects a plain user `struct`
  ("not a declared event type"). The event *types* are the canonical
  `CompactStandardLibrary` ones: `Misc` (general purpose: `name` + `payload`),
  `Paused`/`Unpaused`, and the `Shielded*`/`Unshielded*` token events.
- **A "custom event" is a `Misc` event whose `payload` is your own struct**, packed with
  `serialize<T, 256>(...)`: `name` is a `Bytes<32>` tag identifying the app event, and the
  256-byte payload carries the data (each field little-endian, zero-padded right). Off-chain
  consumers filter the event stream by `name`, then `deserialize` the payload back into `T`.
  This is exactly the pattern in the main repo's `signet-signer.compact`
  (`emitPart` → `emit(Misc { name, payload: serialize<EventPart, 256>(...) })`).

### Cross-contract call

```compact
// 1. Declare the callee's exported circuit surface (signatures only).
contract Token {
  circuit deposit(amount: Uint<128>): [];
}

// 2. Hold a reference to a deployed instance, fixed at deploy time.
export sealed ledger token: Token;

constructor(t: Token) { token = disclose(t); }  // disclose: it lands in public state

// 3. Call it. Compiler lowers this to a crossContractCall.
export circuit depositViaVault(amount: Uint<128>): [] {
  token.deposit(disclose(amount));
}
```

The reference is a `ContractAddress` under the hood (constructor arg is
`{ bytes: Uint8Array(32) }`). The compiler emits `contractReferenceLocations` marking that
ledger cell as a `contractAddress`; at call time the runtime reads it, fetches the callee's
on-chain state via the public data provider, and assembles one transaction whose call tree
carries a proof per contract. Proving is driven by a `ZKConfigRegistry([...zkConfigs])`
that joins calls to artifacts by the SHA-256 of the deployed verifier key (the compiler
writes each circuit's `expectedVk`).

**Calling it (midnight-js).** In beta.3, `findDeployedContract(...).callTx.<circuit>()`
enables cross-contract calls automatically — it queries the latest block, resolves every
callee's state at that block via the `publicDataProvider`, and submits one multi-contract
transaction. The only extra wiring the app must do is give the **proof provider a registry
spanning every contract in the call tree**, so proofs for the callee resolve too. lib's
default `createProofServerProvider` registers a single contract; this package uses the new
`createCrossContractProofServerProvider(url, [vaultZk, tokenZk])` (added to lib) instead —
see [`src/providers.ts`](src/providers.ts).

## Live integration test

[`tests/integrationTest.test.ts`](tests/integrationTest.test.ts) proves the whole thing
on a real stack: deploy token (B) → deploy vault (A, referencing B) → `depositViaVault(4242)`
→ assert **B's ledger moved** (`depositCount +1`, `lastAmount == 4242`) and A's counter
advanced. Because `depositViaVault` touches B's state only through the cross-contract call,
a mutated token ledger *is* on-chain proof the call landed and B's `deposit` (event and all)
executed under real proving.

> Not executed in this spike — it needs a running node + indexer + proof server and a funded
> `DEPLOYER_SEED`. It is gated (`RUN_INTEGRATION_TESTS`), typechecks, and skips cleanly
> offline; the offline unit tests are what's been run green here.

## Simulator reach limits (why the tests assert what they do)

A pure in-process run (no node/indexer) can't see everything:

- **Events**: the emit writes to the circuit's public transcript, which sits behind an
  opaque WASM handle in-process. Event *delivery* is only observable on a live node via the
  indexer's event stream. So the test proves the custom payload **round-trips** (encode
  in-circuit → decode in TS), the emit path **runs** (ledger mutates), and it **compiled**
  to a `log` op.
- **Cross-contract**: a live call resolves the callee state over the network. In-process
  the test asserts the compiler **wired** the reference (`contractDependencies` extracts the
  callee address exactly as the SDK does before assembling the tx) and **lowered** the call
  (`crossContractCall` / `'deposit'` in the generated code).

Full end-to-end (real proofs + a deployed callee + event streaming) needs a running node +
indexer and the v5 `ZKConfigRegistry` wiring — out of scope for this compile/simulator spike.
