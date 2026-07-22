# Sig Network Midnight Integration

The [Sig Network](https://sig.network) [Distributed MPC](https://github.com/sig-net/mpc) integration for the [Midnight Blockchain](https://midnight.network) allows contracts on Midnight to execute arbitrary transactions on foreign blockchains.

It does this by exposing the MPC's [sign bidirectional flow](https://docs.sig.network/architecture/sign-bidirectional) to contracts on Midnight.

The **Sign Bidirectional Flow** comprises of 5 steps:
1. Client calls a contract on Midnight which requests a signature for a transaction destined for a foreign chain. The signature is made with a key derived for the requesting contract (see [Derived keys](#derived-keys)).
2. Sig Network MPC honours the request, generating the transaction signature and posting it back to Midnight
3. Client extracts the signature, using it to submit the signed transaction to the foreign chain
4. Sig Network MPC observes the foreign transaction and posts the output of the execution (signed) back to Midnight
5. Client extracts the signed foreign execution output, then submits it back to the Midnight contract completing the foreign transaction execution.

> ## 🚧 Under Construction 🚧
>
> This Sig Network Midnight Integration is still Under Construction.
> Use at your own risk and expect rapid iteration.

## Derived keys

Every key the MPC signs with is scoped by the requesting contract:

`derivedSigningKey = f(mpcRootKey[keyVersion], contractAddress, path)`

The path is 32 opaque bytes of the contract's choosing (a fixed literal for a contract-owned account, a hash of a caller's secret for per-user accounts). There are no format requirements. The contract address is always part of the derivation, so no contract can reach another contract's derived keys.

This repository contains the pieces that make that flow available on Midnight: the Sig Network protocol singleton contract, the client-agnostic SDK that contract builders integrate against, and a minimal caller contract that exercises the protocol end to end.

Example applications built on this integration (such as an ERC20 cross chain vault demo) live in [`sig-net/midnight-examples`](https://github.com/sig-net/midnight-examples).

Jump to the [Quickstart](#quickstart) to get going or start reading at [Packages](#packages) to gain a deeper understanding of what you can find in this repository.

# Quickstart

The quickest way to get going with this repository is to get the generic end to end integration suite running locally. It drives the smallest possible client (the caller [contract](./packages/caller-contract/src/signet-caller.compact)) through the protocol: submit a signature request, get discovered via the notification registry, receive the MPC signature, and verify it in-circuit.

1. Ensure you have all of the [prerequisites](#prerequisites) installed.
2. From the repository root, install workspace dependencies and select the required Compact toolchain explicitly:
   ```sh
   corepack enable
   yarn install
   compact update 0.33.0-rc.2   # Exact version required.
                                # `compact update` installs/downgrades
                                # to stable.
   ```
3. Start the local stack (Midnight node, indexer, proof server, anvil EVM) with `docker compose up -d`. The fakenet MPC responder is started automatically by the test setup once the signet contract is deployed.
4. Run the suite and watch it go. The first run can take **~10–25 minutes** (it generates zk proving keys for both contracts, deploys them and hands off to the fakenet responder, all automatically, no `.env` inserts needed):
   ```sh
   yarn test:integration-tests
   ```
   Green looks like `Tests  4 passed (4)`. Afterwards, save the printed `MIDNIGHT_CALLER_CONTRACT_ADDRESS` into `.env` so the next run skips compile and deploy (~2 minutes; the signet contract address is appended to `.env` automatically).

**TIP:** If you are using Claude Code you can ask it to do all of this for you using this [skill](.claude/skills/e2e/SKILL.md), for example:
```
Use your /e2e skill to get the integration suite running for me, from fresh clone to green. Recover the run yourself if anything fails along the way.
```

**NOTE:** The most common reason that a run fails is the proof server hanging or crashing when it exhausts memory on a proving leg. This most often presents as the test failing with `connect ECONNREFUSED 127.0.0.1:6300`, with `docker ps -a` showing the proof server container as `Exited (137)`, i.e. OOM-killed. If this happens, restart the proof server and rerun; with the contract addresses kept in `.env` the rerun skips straight to the flow.

## Unit tests (offline)

The contract packages also carry simulator-level unit tests that need no docker stack at all:

```sh
yarn compile                      # generates each contract package's src/managed/ (skip-zk)
yarn compile:signet-contract:zk   # signet-contract's build gates on its prover keys
yarn build && yarn test           # typecheck + unit tests (simulator-only, offline)
```

# Prerequisites

| Prerequisite | Version | Check With | Where to Get It |
| ------- | ------| ------  |----------- |
| Node | ≥ 20 (22+ recommended) | `node --version` | [nodejs.org](https://nodejs.org) or your version manager (nvm, fnm, …) |
| Yarn 4 (via Corepack) | 4.x | `corepack enable && yarn --version` | Corepack ships with Node; the repo's `packageManager` field pins the Yarn version |
| Compact toolchain | compiler 0.33.0-rc.2 | `compact compile --version` → `0.33.0` | Install the `compact` launcher per [Midnight's docs](https://docs.midnight.network/), then `compact update 0.33.0-rc.2` (compiler builds live at [LFDT-Minokawa/compact releases](https://github.com/LFDT-Minokawa/compact/releases)). If the launcher refuses the rc version, use the direct-download recipe in [.github/workflows/ci.yml](.github/workflows/ci.yml) |
| A docker environment | any recent engine | `docker --version` | [Docker Desktop](https://www.docker.com/products/docker-desktop/) (macOS/Windows) or your distro's engine, with **≥ 16 GB RAM allocated** (see note) |
| Docker Compose v2 | ≥ 2.x | `docker compose version` | Included with Docker Desktop; plugin package on Linux |

**NOTE:** the midnight proof server is quite heavy. It is recommended that you allocate at least 16 GB of RAM to your docker environment, otherwise expect to have to restart the tests as the proof server hangs.

# Packages

| Package | npm | What it is |
|---|---|---|
| [`packages/signet-midnight`](packages/signet-midnight) | `@sig-net/midnight` | Client-agnostic signet protocol library: shared Compact modules, TS twins of the wire structs, state readers, request feed/resolver, crypto (epsilon derivation, Schnorr) |
| [`packages/signet-contract`](packages/signet-contract) | `@sig-net/midnight-contract` | The central singleton contract: signature-response log (in-circuit Schnorr verified) + request-notification registry |
| [`packages/signet-contract-deploy`](packages/signet-contract-deploy) | `@sig-net/midnight-contract-deploy` | Deploy tooling for the singleton + the generic deploy/wallet plumbing |
| [`packages/caller-contract`](packages/caller-contract) | repo-private | The minimal client contract: submit a signature request, verify the Schnorr response, the smallest thing that drives the protocol |
| [`packages/caller-contract-20-field`](packages/caller-contract-20-field) | repo-private | A 20-field requester contract: the lockstep fixture proving the raw ledger readers resolve field numbers through the compiler's chunked (>15-field) state layout |
| [`packages/integration-tests`](packages/integration-tests) | repo-private | The generic e2e suite: submit → notification → MPC signature → in-circuit verify, against the local docker stack (`docker-compose.yaml`: midnight node/indexer/proof server + anvil EVM + fakenet MPC responder) |
| [`packages/lib`](packages/lib) | repo-private | Shared midnight-js provider adapters |
