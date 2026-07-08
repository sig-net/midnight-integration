# Cross-contract calls on compactc 0.33 / midnight-js 5.0.0-beta.3

Back to [`index.md`](index.md) · related: [`events.md`](events.md), [`deploy-call-and-testing.md`](deploy-call-and-testing.md), [`gotchas.md`](gotchas.md)

A cross-contract (a.k.a. inter-contract) call is one circuit in contract **A** calling an
exported circuit of another **deployed** contract **B**, inside a **single transaction** whose
call tree carries a proof per contract. Introduced in midnight-js **v5.0.0**.

## The three pieces of Compact syntax (all verified compiling)

From [`src/vault.compact`](../src/vault.compact) (contract A calling contract B):

```compact
pragma language_version >= 0.25;
import CompactStandardLibrary;

// (1) EXTERNAL CONTRACT DECLARATION — the callee's exported circuit surface,
//     signatures only, no body. `circuit` keyword REQUIRED. `export` optional.
//     This names a *contract type* `Token` usable as a ledger/param type.
contract Token {
  circuit deposit(amount: Uint<128>): [];
}

// (2) A REFERENCE to a deployed instance, pinned at deploy time → `sealed`.
export sealed ledger token: Token;
export ledger vaultCallCount: Counter;

constructor(t: Token) {
  token = disclose(t);          // writing a param into public ledger state = disclosure
}

// (3) THE CALL. `ref.circuit(args)`. Compiler lowers to a crossContractCall.
export circuit depositViaVault(amount: Uint<128>): [] {
  vaultCallCount.increment(1);
  token.deposit(disclose(amount));
}
```

### Rules that the compiler actually enforces (compactc 0.33)

- External circuit decls need the `circuit` keyword: `circuit deposit(...): T;`. Omitting it →
  `parse error: found "deposit" looking for an external contract circuit or "}"`.
- A contract reference is a `ContractAddress` under the hood. Its **constructor argument from
  TypeScript is `{ bytes: Uint8Array(32) }`** (NOT a hex string — see [gotcha #6](gotchas.md#6)).
- References must be **initialized in the constructor** and are effectively `sealed` (all
  reachable contracts are known at deploy time; no dynamic instantiation).
- Writing a param/witness-derived value into ledger state (incl. a contract ref) requires
  `disclose(...)`.
- **Not yet supported** (compiler rejects, per architecture proposals 0010/0011 that are only
  partially implemented): contract types in circuit params/returns or witness returns;
  multiple `contract {}` blocks defining deployable contracts in one file; `interface` types;
  dynamic instantiation. Treat the proposals as aspirational — probe the compiler.

## How the compiler lowers it (generated `managed/vault/contract/index.js`)

```js
await __compactRuntime.crossContractCall(
  context,
  __compactContractsImport_Token,     // the external contract binding
  'deposit',                          // callee circuit id
  __compactRuntime.decodeContractAddress(/* address read from ledger cell holding `token` */),
  false,
  partialProofData,
  amount_0,                           // forwarded arg
);
```

And it emits a `contractReferenceLocations` map marking the ledger cell as a contract address:
```js
export const contractReferenceLocations =
  { tag: 'publicLedgerArray', indices: { 0: { tag: 'cell',
      valueType: { tag: 'compactValue', descriptor: _descriptor_2, sparseType: { tag: 'contractAddress' } } } } };
```
The runtime uses this (via `contractDependencies(locations, stateValue)` in
`@midnight-ntwrk/compact-runtime`) to extract callee addresses from a contract's state — the
addresses whose on-chain state must be fetched before assembling the call. Offline you can
assert this: `contractDependencies(Vault.contractReferenceLocations, state.data.state)` returns
`[tokenAddress]` (see [`tests/xcontract-events.test.ts`](../tests/xcontract-events.test.ts)).

Relevant `compactc` flag: `--no-communications-commitment` *"omits the contract communications
commitment that enables data integrity for contract-to-contract calls."* Default = **on**
(commitment included). Don't disable it — it's what binds a callee's inputs/outputs into the
caller's proof (see [`authenticity-and-signing.md`](authenticity-and-signing.md) § 3a).

### Callees can return values (VERIFIED)

A cross-contract call is not fire-and-forget — the callee circuit can **return a value** and
the caller captures it: `const h = token.deposit(amount);` where
`export circuit deposit(amount: Uint<128>): Bytes<32>`. The return crosses the boundary as its
concrete TS type (`Bytes<32>` → `Uint8Array`). This is the basis for a *trusted* return (B
hands A a commitment to what it did, bound by the communication commitment) — see
[`authenticity-and-signing.md`](authenticity-and-signing.md) § 3. (The main package's contracts
return `[]`; the returning variant is documented there.)

## Calling it from TypeScript (midnight-js) — the auto-wiring

**You do not write any special call-site code.** In midnight-js 5.0.0-beta.3,
`findDeployedContract(providers, ...).callTx.<circuit>(...args)` **automatically** enables
cross-contract calls:

- it queries the **latest block** (`publicDataProvider.queryBlock()`),
- resolves every callee's on-chain state **at that block** (a coherent snapshot),
- assembles ONE multi-contract transaction and passes `crossContract: { publicDataProvider,
  blockHash }` into the call-tx builder.

Source: `node_modules/@midnight-ntwrk/midnight-js-contracts/dist/index.mjs`,
`createUnprovenCallTx` (≈ lines 1580-1596 in beta.3) — it *unconditionally* passes the
`crossContract` config. Callee states are fetched lazily/on-demand and memoized
(`makeCalleeStateResolver`, same file; and `contract-state-provider.ts` upstream).

So the call site is just:
```ts
const vault = await findDeployedContract(providers, {
  contractAddress: vaultAddress,
  compiledContract: vaultCompiledContract,
  privateStateId: VAULT_PRIVATE_STATE_ID,
  initialPrivateState: createVaultPrivateState(),  // {} for witness-less
});
const result = await vault.callTx.depositViaVault(4242n);   // ← does the cross-contract call
// result.public.txId is the chain tx id
```

## THE one thing you must wire yourself: a multi-contract proof provider ⚠ (biggest gotcha)

Proving a cross-contract call needs ZK artifacts (prover/verifier keys + ZKIR) for **every
contract in the call tree** — the caller AND each callee. midnight-js resolves these via a
`ZKConfigRegistry`, which joins each call to its artifacts by the **SHA-256 of the deployed
verifier key** (canonical key location `contract:<addr>/<circuitId>?vk=<hash>`). The join is
immune to redeploys and circuit-name collisions (source:
`@midnight-ntwrk/midnight-js-types` `ZKConfigRegistry.resolve`, ≈ index.mjs:497-521).

**The trap:** lib's default `createProofServerProvider(url, oneZkConfigProvider)` registers a
**single** contract. If you use it for a cross-contract caller, proving fails at the `/check`
step with:

```
ZKArtifactNotFoundError: No ZK artifact bundle matches the deployed verifier key
for contract '<callee addr>', circuit '<callee circuit>'.
The local compiled artifacts are missing or stale with respect to the deployed contract.
```

This is **misleading** — the artifacts are usually *fine* (verified: local `.verifier` file
hash == on-chain `ContractOperation.verifierKey` hash, `e960aa91…`). The real cause: the base
`httpClientProvingProvider`'s own key resolver (`makeKeyMaterialResolver`,
`@midnight-ntwrk/midnight-js-http-client-proof-provider` index.mjs:45-63) was handed only the
caller's provider, so `/check` can't resolve the **callee's** verifier key.

**The fix** (this repo): a helper that builds the registry over **all** contracts and passes
the *registry itself* into `httpClientProvingProvider` (its resolver special-cases
`zkConfigProvider instanceof ZKConfigRegistry`, index.mjs:46). See
[`../../lib/src/midnight-providers.ts`](../../lib/src/midnight-providers.ts)
`createCrossContractProofServerProvider` (line ~111). Used in
[`src/providers.ts:107`](../src/providers.ts):

```ts
proofProvider: createCrossContractProofServerProvider(config.proofServerUrl, [
  vaultZkConfigProvider,   // caller (root)
  tokenZkConfigProvider,   // callee
]),
```

Also note (documented in lib): **ledger-v9 1.0.0-rc.3 requires the proving provider to expose
a `lookupKey` function** or it throws *"expected proving provider property 'lookupKey' to be a
function"* on every circuit-call proof. The helper grafts `lookupKey` (backed by the same
registry) onto the base `check`/`prove` provider. See [gotcha #4](gotchas.md#4).

### Provider set shape for a cross-contract caller

From [`src/providers.ts` `buildVaultProviders`](../src/providers.ts):
```ts
{
  privateStateProvider: levelPrivateStateProvider({ ...package-scoped store names... }),
  publicDataProvider:   indexerPublicDataProvider({ queryURL, subscriptionURL }),  // object form!
  zkConfigProvider:     vaultZkConfigProvider,                    // the ROOT contract's own
  proofProvider:        createCrossContractProofServerProvider(url, [vaultZk, tokenZk]),  // ALL of them
  walletProvider:       walletAndMidnightProvider,
  midnightProvider:     walletAndMidnightProvider,
}
```
`zkConfigProvider` is the root contract's; the cross-contract resolution happens in
`proofProvider`. Each is a `new NodeZkConfigProvider<CircuitId>(managedPath)` pointed at that
contract's `managed/` dir.

## Verifying it worked (what to assert)

A cross-contract call has no local effect on the callee's state — so **the callee's ledger
moving is the proof the call landed on-chain**:
- read `B`'s ledger before and after: `depositCount` +1, `lastAmount == amount`.
- read `A`'s own ledger: its counter advanced (same tx).
- (bonus) read `B`'s emitted event off the indexer — see [`events.md`](events.md) § "Reading
  events back". The event is emitted *inside* the cross-contract call, so its presence
  double-confirms the call executed B's circuit under real proving.

All of this is in [`tests/integrationTest.test.ts`](../tests/integrationTest.test.ts) and passes
against the live stack.
