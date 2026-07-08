# Knowledge base: cross-contract calls & events on Midnight (compactc 0.33 / midnight-js v5)

> **What this is.** A field-tested reference for writing, deploying, calling, and observing
> **cross-contract calls** and **contract events (MIP-0002)** on the exact toolchain this
> repo pins. Official docs for both features are immature/contradictory as of 2026-07; the
> facts here are **verified empirically** against the real compiler and a live local stack,
> not copied from docs. The `packages/xcontract-events` package IS the worked example —
> every claim below has runnable code behind it.
>
> **Audience: agents.** Read [`index.md`](index.md) (this file) first for the TL;DR + version
> matrix + file router, then jump to the topic file you need. Every fact is stated flatly with
> a citation (`file:line` in this repo, or a GitHub URL). Gotchas are consolidated in
> [`gotchas.md`](gotchas.md) — **read it before writing any code**.

## Status: both features work end-to-end (VERIFIED)

Verified on a live local stack (`docker-compose.yaml`: node 2.0.0-rc.3, indexer
4.4.0-pre-alpha.16 contract-events build, proof-server 9.0.0-rc.3) by
[`tests/integrationTest.test.ts`](../tests/integrationTest.test.ts) — **12/12 tests pass**:

1. Deploy token contract **B** (callee, emits an event).
2. Deploy vault contract **A** (caller), sealing a reference to B.
3. Call `A.depositViaVault(4242)` → **one transaction** that cross-contract-calls `B.deposit(4242)`.
4. Observe `B.depositCount` 0→1 and `B.lastAmount == 4242` (the call reached B).
5. Read B's `Misc("deposit")` event off the indexer: `amount=4242 sequence=0` (the event published on-chain).

## Version matrix (the whole point — these exact versions)

| Component | Version | How to confirm |
|---|---|---|
| `compact` CLI | 0.5.1 | `compact --version` |
| **`compactc` (compiler)** | **0.33.0** | `compact compile --version` |
| Compact **language version** | **0.25.0** | `compactc.bin --language-version` |
| ledger (compiler target) | `ledger-9.1.0.0-rc.2` | `compactc.bin --ledger-version` |
| compact runtime (compiler target) | `0.18.0-rc.0` | `compactc.bin --runtime-version` |
| `@midnight-ntwrk/compact-runtime` | `0.18.0-rc.0` | `package.json` |
| `@midnight-ntwrk/midnight-js*` | `5.0.0-beta.3` | `package.json` |
| `@midnightntwrk/ledger-v9` | `1.0.0-rc.3` | root `package.json` overrides |
| `@midnightntwrk/onchain-runtime-v4` | `4.0.0-rc.2` | root `package.json` overrides |

Cross-contract calls are the headline feature of **midnight-js v5.0.0**; events are
**MIP-0002**, needing **compactc ≥ 0.33 + compact-runtime 0.18.x**. This repo sits on both
lines (pre-release: `beta`/`rc`, so expect rough edges). See [`toolchain.md`](toolchain.md).

## One-paragraph TL;DR of each feature

- **Events.** `emit (EventType { ... });`. You **cannot declare your own event type** (the
  `event` keyword is reserved). Event types come only from `CompactStandardLibrary` (11 of
  them; `Misc` is the general-purpose one). A "custom event" = `Misc { name: <Bytes<32> tag>,
  payload: serialize<YourStruct, 256>(...) }`. Read them back via
  `publicDataProvider.queryContractEvents(...)`. Full detail: [`events.md`](events.md).
- **Cross-contract calls.** Declare the callee's surface inline with an external
  `contract Name { circuit foo(args): T; }` block, hold a `sealed ledger ref: Name`
  initialized in the constructor, and call `ref.foo(args)`. midnight-js's `callTx`
  auto-assembles the multi-contract transaction. **The one non-obvious requirement:** the
  proof provider must resolve ZK keys for **every** contract in the call tree (a
  `ZKConfigRegistry` over all of them), or proving fails at `/check`. Full detail:
  [`cross-contract-calls.md`](cross-contract-calls.md).

## File router

| File | Read it when you need to… |
|---|---|
| [`events.md`](events.md) | Emit an event, encode a custom payload, or read/decode events off the indexer. |
| [`cross-contract-calls.md`](cross-contract-calls.md) | Have contract A call contract B; understand references, lowering, and the proof-provider wiring. |
| [`generics.md`](generics.md) | Use type parameters (`<T>`) — and why you can't export a generic circuit; the monomorphic boundary. |
| [`authenticity-and-signing.md`](authenticity-and-signing.md) | Prove an event is legitimate (not node-forged); the cross-contract communication commitment; whether a contract can "sign"; built-in curves/hashes/Schnorr. |
| [`caller-attribution.md`](caller-attribution.md) | Design reasoning for routing signature requests through a shared contract (vault → signet): why an event's `sender` field is **not** trustworthy on Midnight, the theft vector, and how to re-establish caller attribution for an MPC. |
| [`toolchain.md`](toolchain.md) | Compile contracts, understand `compactc` flags/versions, or the `managed/` output layout. |
| [`deploy-call-and-testing.md`](deploy-call-and-testing.md) | Deploy contracts, call circuits from TS, or run the live integration test. |
| [`gotchas.md`](gotchas.md) | **Always, first.** Every trap, non-obvious bug, and version quirk hit during this research. |

## The worked-example package (all runnable, all cited)

| Path | What it demonstrates |
|---|---|
| [`src/token.compact`](../src/token.compact) | Contract **B**: emits a custom event (`Misc` + `serialize`d struct). |
| [`src/vault.compact`](../src/vault.compact) | Contract **A**: external `contract` decl + `sealed ledger` ref + cross-contract call. |
| [`src/providers.ts`](../src/providers.ts) | Provider set with a **two-contract** proof provider (the crux). |
| [`src/deploy.ts`](../src/deploy.ts) | `deployToken()` / `deployVault(tokenAddr)`. |
| [`tests/xcontract-events.test.ts`](../tests/xcontract-events.test.ts) | Offline in-process simulator checks (7 tests). |
| [`tests/integrationTest.test.ts`](../tests/integrationTest.test.ts) | Live e2e incl. reading the event off the indexer (5 steps). |
| [`../../lib/src/midnight-providers.ts`](../../lib/src/midnight-providers.ts) | `createCrossContractProofServerProvider` (lib helper added for this). |

## External references (authoritative-ish, but often ahead of / behind the shipped compiler)

- v5.0.0 new features (cross-contract + events): <https://github.com/midnightntwrk/midnight-js/blob/main/docs/releases/v5.0.0/new-features.md>
- `events.compact` canonical example: <https://github.com/midnightntwrk/midnight-js/blob/main/testkit-js/testkit-js-e2e/src/contract/events.compact>
- Compact grammar, external contract declaration: <https://docs.midnight.network/compact/reference/compact-grammar#external-contract-declaration>
- Architecture proposal 0010 (composable contracts syntax): <https://github.com/midnightntwrk/midnight-architecture/blob/main/proposals/0010-composable-contracts-syntax.md>
- Architecture proposal 0011 (contract interface types): <https://github.com/midnightntwrk/midnight-architecture/blob/main/proposals/0011-contract-interface-types.md>
- Real-world custom-event pattern in this org's OLD checkout: `~/Projects/github.com/sig-net/midnight-erc20-vault/boilerplate/contract/src/signet-signer.compact` (`emitPart` circuit).

**Live docs search (use this, docs move fast):** the `mcp__midnight-docs__search_midnight_knowledge_sources` MCP tool does semantic retrieval over Midnight docs + source repos. Prefer it over training-data recall for anything version-sensitive.

> ⚠️ **Trust order:** shipped compiler behavior > this KB > midnight-js source in `node_modules` > architecture proposals/docs. The proposals describe an aspirational language (e.g. `interface`, multiple `contract` blocks per file, `[T]` generics) that is **only partially implemented** in compactc 0.33. When in doubt, write a 5-line `.compact` and compile it — see [`toolchain.md`](toolchain.md) § "Probe the compiler".
