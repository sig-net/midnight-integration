# Deploy, call, and test (live stack)

Back to [`index.md`](index.md) · related: [`cross-contract-calls.md`](cross-contract-calls.md), [`gotchas.md`](gotchas.md)

## The local stack

[`docker-compose.yaml`](../../../docker-compose.yaml) (repo root) brings up node + indexer +
proof server. Bring it up with `docker compose up -d`. Pinned images (keep the set aligned
with the npm `ledger-v9` version):

| Service | Image | Port |
|---|---|---|
| node | `midnightntwrk/midnight-node:2.0.0-rc.3` | `127.0.0.1:9944` |
| indexer | `midnightntwrk/indexer-standalone:4.4.0-pre-alpha.16-...-contract-zswap-…` (a **contract-events** build — decodes MIP-0002 `Misc`) | `127.0.0.1:8088` |
| proof-server | `midnightntwrk/proof-server:9.0.0-rc.3` | `127.0.0.1:6300` |

Default endpoints for the `undeployed` network (from `@midnight-erc20-vault/lib`
`getMidnightNodeConfig`): node `http://127.0.0.1:9944`, indexer
`http://127.0.0.1:8088/api/v3/graphql` (+ `/ws`), proof server `http://127.0.0.1:6300`.

## Genesis wallet (default deployer)

`getDeployConfig(env).deployerSeed` defaults to the **genesis mint wallet seed**
`0000…0001` when `DEPLOYER_SEED` is unset (lib `deploy.ts`). On a local dev chain this wallet
is pre-funded with NIGHT/DUST, so deploys + calls work with **no env at all**. To use a
different wallet, set `DEPLOYER_SEED` (hex or mnemonic).

## Deploy flow (contracts are witness-less here)

See [`src/deploy.ts`](../src/deploy.ts). Order matters: **deploy B (token) first**, then A
(vault) with B's address.

```ts
// B — no constructor args:
const { contractAddress: tokenAddr } = await deployToken(env);

// A — constructor takes a reference to the deployed B. The address hex is converted to
//     { bytes: Uint8Array(32) } by contractAddressToReference().
const { contractAddress: vaultAddr } = await deployVault(tokenAddr, env);
```

Under the hood each deploy: `buildDeployTransaction(compiledContract, networkId, coinPubKey,
privateState, ...ctorArgs)` (lib) → runs the Compact constructor via compact-js, attaches
verifier keys from `managed/*/keys` (⇒ **must `compile:zk` first**), wraps in a ledger deploy
intent → `submitUnprovenTransaction(facade, keys, tx)` balances/signs/finalizes/submits
through the wallet facade. Witness-less contracts bind via `makeVacantCompiledContract`
(vs `makeCompiledContract` for contracts with witnesses); private state is `{}`.

CLI shells: `npm run deploy:token`, then `XC_TOKEN_CONTRACT_ADDRESS=<addr> npm run deploy:vault`.

## Calling a circuit from TS

```ts
setNetworkId(networkId);                                  // midnight-js reads a process-global
const providers = buildVaultProviders(facade, keys, cfg); // see src/providers.ts
const vault = await findDeployedContract(providers, {
  contractAddress: vaultAddr,
  compiledContract: vaultCompiledContract,
  privateStateId: VAULT_PRIVATE_STATE_ID,
  initialPrivateState: createVaultPrivateState(),         // {} witness-less
});
const result = await vault.callTx.depositViaVault(4242n); // cross-contract call auto-wired
// result.public.txId  → chain tx id
```

Reading raw ledger state (for assertions):
```ts
const st = await publicDataProvider.queryContractState(address);   // may be null
const ledger = Token.ledger(st.data);                              // decode via generated ledger()
// st.data is an opaque WASM StateValue; contractDependencies() wants st.data.state (unwrap ChargedState)
```

## The integration test

[`tests/integrationTest.test.ts`](../tests/integrationTest.test.ts). Gated by
`RUN_INTEGRATION_TESTS` (skips otherwise, so offline `npm test` stays green). Single file,
sequential steps sharing an `env` accumulator so re-runs can resume:

1. environment: node/indexer/proof-server reachable.
2. deploy token (B) → `env.XC_TOKEN_CONTRACT_ADDRESS`.
3. deploy vault (A, referencing B) → `env.XC_VAULT_CONTRACT_ADDRESS`.
4. call `depositViaVault(4242)` → assert `B.depositCount` +1, `B.lastAmount == 4242`, `A.vaultCallCount` ≥ 1.
5. read the `Misc("deposit")` event off the indexer → assert `amount == 4242`, `sequence == 0`, `contractAddress == token`.

Run it:
```bash
docker compose up -d                       # from repo root, if not already up
cd packages/xcontract-events
npm run compile:zk                          # generate proving/verifier keys for BOTH contracts
npm run test:integration                    # RUN_INTEGRATION_TESTS=1 vitest run ... integrationTest.test.ts
```
Set `XC_TOKEN_CONTRACT_ADDRESS` / `XC_VAULT_CONTRACT_ADDRESS` to skip deploys and reuse
existing contracts (note: the `sequence == 0` assertion assumes a fresh token — see
[gotcha #11](gotchas.md#11)).

Typical run: ~60s (two zk deploys + one cross-contract proof + event poll). Expected tail:
```
token.depositCount after: 1, lastAmount: 4242
vault.vaultCallCount after: 1
indexer event: id=… type=Misc name="deposit" amount=4242 sequence=0 tx=…
Test Files  2 passed (2)   Tests  12 passed (12)
```

## Offline tests (no stack)

[`tests/xcontract-events.test.ts`](../tests/xcontract-events.test.ts) — in-process simulator
via `@midnight-ntwrk/compact-runtime`. Asserts custom-event payload round-trips, the emit
path runs + compiled to `'log'`, the cross-contract call lowered to `crossContractCall`, and
`contractDependencies` extracts the callee address. Run with `npm test`.

## Noise you can ignore

- `RPC-CORE: subscribeRuntimeVersion(): ... disconnected from ws://127.0.0.1:9944/: 1000:: Normal Closure`
  during deploy — harmless wallet-facade reconnect chatter.
- `Sourcemap for ".../managed/.../index.js" points to missing source files` — harmless
  (generated JS references the `.compact` source path).
