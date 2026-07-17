# Sig Network Midnight Integration

The [Sig Network](https://sig.network) [Distributed MPC](https://github.com/sig-net/mpc) [Midnight Blockchain](https://midnight.network) Integration allows contracts on Midnight to execute arbitrary transactions on foreign blockchains.

This repository contains the Sig Network protocol singleton contract and the
associated SDK that let contract builders on Midnight leverage this chain
signature technology, plus a minimal caller contract that exercises the
protocol end to end.

Example applications built on these packages — such as the ERC20 vault demo —
live in [`sig-net/midnight-examples`](https://github.com/sig-net/midnight-examples),
consuming the published `@sig-net/*` npm packages.

## Quick start

```sh
corepack enable
yarn install
compact update 0.33.0-rc.0        # the rc toolchain matching the ledger-9 stack
yarn compile                      # generates each contract package's src/managed/ (skip-zk)
yarn compile:signet-contract:zk   # signet-contract's build gates on its prover keys
yarn build && yarn test           # typecheck + unit tests (simulator-only, offline)
```

To run the end-to-end suite against the local docker stack, follow
[`.claude/skills/e2e/SKILL.md`](.claude/skills/e2e/SKILL.md) — the
operational runbook from a fresh clone to a green suite:

```sh
docker compose up -d
yarn test:integration-tests
```

## Packages

| Package | npm | What it is |
|---|---|---|
| [`packages/signet-midnight`](packages/signet-midnight) | `@sig-net/midnight` | Client-agnostic signet protocol library: shared Compact modules, TS twins of the wire structs, state readers, request feed/resolver, crypto (epsilon derivation, Schnorr) |
| [`packages/signet-contract`](packages/signet-contract) | `@sig-net/midnight-contract` | The central singleton contract: signature-response log (in-circuit Schnorr verified) + request-notification registry |
| [`packages/signet-contract-deploy`](packages/signet-contract-deploy) | `@sig-net/midnight-contract-deploy` | Deploy tooling for the singleton + the generic deploy/wallet plumbing |
| [`packages/caller-contract`](packages/caller-contract) | repo-private | The minimal client contract: submit a signature request, verify the Schnorr response — the smallest thing that drives the protocol |
| [`packages/integration-tests`](packages/integration-tests) | repo-private | The generic e2e suite: submit → notification → MPC signature → in-circuit verify, against the local docker stack (`docker-compose.yaml`: midnight node/indexer/proof server + anvil EVM + fakenet MPC responder) |
| [`packages/lib`](packages/lib) | repo-private | Shared midnight-js provider adapters (the only copy) |
| [`packages/xcontract-events`](packages/xcontract-events) | repo-private | Cross-contract call + event research (MIP-0002); start with its `knowledge-base/` |

Workspace-wide rules live in [AGENTS.md](AGENTS.md) (CLAUDE.md points there);
CI is [.github/workflows/ci.yml](.github/workflows/ci.yml) (unit + signet-caller
e2e + weekly zk canary); remaining work is tracked in [task.md](task.md).
