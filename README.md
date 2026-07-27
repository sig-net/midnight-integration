# Sig Network Midnight Integration

The [Sig Network](https://sig.network) [Distributed MPC](https://github.com/sig-net/mpc) integration for the [Midnight Blockchain](https://midnight.network) allows contracts on Midnight to execute arbitrary transactions on foreign blockchains.

> ## 🚧 Under Construction 🚧
>
> This Sig Network Midnight Integration is still Under Construction.
> Use at your own risk and expect rapid iteration.

This integration achieves this by exposing the MPC's [sign bidirectional flow](https://docs.sig.network/architecture/sign-bidirectional) to contracts on Midnight.

This repository contains the pieces that make that flow available on Midnight: the Sig Network protocol singleton contract, the client-agnostic SDK that contract builders integrate against, and two test caller contracts that exercise the protocol end to end. Example applications built on this integration (such as an ERC20 cross chain vault demo) live in [`sig-net/midnight-examples`](https://github.com/sig-net/midnight-examples).

Read more about the [Sign Bidirectional Flow](#sign-bidirectional-flow), or jump straight to the [Integrator Guide](#integrator-guide) or the [Contributor Guide](#contributor-guide) depending on your goal. The [Prerequisites](#prerequisites) are relevant to both.

# Sign Bidirectional Flow

The flow comprises 5 steps:
1. Client calls a contract on Midnight which requests a signature for a transaction destined for a foreign chain. The signature is made with a key derived for the requesting contract (see [Derived keys](#derived-keys)).
2. Sig Network MPC honours the request, generating the transaction signature and posting it back to Midnight
3. Client extracts the signature, using it to submit the signed transaction to the foreign chain
4. Sig Network MPC observes the foreign transaction and posts an attestation of the execution back to Midnight: its ECDSA signature over the attestation digest `keccak256(requestId || serializedOutput)`. Both the digest and the output itself travel off chain.
5. Client obtains the execution output off chain (see the output recovery note below: it broadcast the transaction in step 3, so it can read the result), extracts the posted attestation and submits both back to the Midnight contract, which recomputes the digest from the output bytes and verifies the MPC's signature in-circuit against the contract's own response key (see [Derived keys](#derived-keys)), completing the foreign transaction execution.

> **Output recovery:** how the client reads the execution output is chain-specific. For EVM chains it is the mined call's return data, extracted with `debug_traceTransaction` (callTracer, top call frame), the same RPC method the MPC observes executions with. Clients without trace access can fetch the raw output from the fakenet responder's helper API at `GET /responses/{requestId}` (served by [`ResponsesApi.ts`](https://github.com/sig-net/solana-signet-program/blob/fakenet-v0.8.0/fakenet-signer/src/server/ResponsesApi.ts), port 3040 in the local stack, consumed here by [`packages/integration-tests/src/fakenet-responses.ts`](packages/integration-tests/src/fakenet-responses.ts)). The fetched bytes are untrusted until step 5's in-circuit signature verification.

## Derived keys

Every key the MPC uses is derived for the requesting contract and a path. There are two kinds: the request signing key, whose path each contract chooses, and the response signing key, whose path is fixed by the protocol. Both key derivations are **scoped by the address** of the requesting contract.

### Request signing key

The key the MPC signs requested foreign transactions with:

`requestSigningKey = f(mpcRootKey[keyVersion], contractAddress, path)`

The path is 32 opaque bytes of the contract's choosing (e.g. a fixed literal for a contract-owned account like "vault" or a hash of a caller's secret for per-user accounts). There are no format requirements. The contract address is always part of the derivation, so no contract can reach another contract's derived keys.

### Response key

The key the MPC signs remote execution attestations with when posting them back to Midnight:

`responseKey = f(mpcRootKey[keyVersion], contractAddress, "midnight response key")`

The same derivation, but with the path fixed to the literal `"midnight response key"`, giving each contract one well-known response key. A contract pins its own response key in its ledger after deploy and verifies every response against it in-circuit (step 5 of the flow above).

# Integrator Guide

Integrating a contract on Midnight with the Sig Network MPC consists of:

- 4 once-off **setup** steps
- 5 per-request **runtime** steps that drive the full sign bidirectional flow

## Setup

Set up your contract for integration with the Sig Network MPC's sign bidirectional flow:

1. Add the protocol library to your project:
   ```sh
   yarn add @sig-net/midnight   # or: npm install @sig-net/midnight
   ```

2. Import the Signet module at the top of your contract (resolved through `node_modules` via `COMPACT_PATH`):
   ```compact
   import "@sig-net/midnight/src/Signet";
   ```

   Then tell the compact compiler about the npm packages with its `COMPACT_PATH` environment variable at compile time:
   ```sh
   COMPACT_PATH=node_modules compact compile --feature-zkir-v3 src/my-contract.compact src/managed/my-contract
   ```

   The Compact toolchain requirements in [Prerequisites](#prerequisites) apply to integrators too: compile with the pinned compiler version (currently `compact update 0.33.0-rc.2`) and always pass `--feature-zkir-v3`, as above.

3. Declare the required Sig Network protocol state in your ledger (plus recommended deployer identity and initialisation state):

   ```compact
   // Required: Map of SignBidirectionalEvent signature requests, configured by transaction type.
   // Configured and sized here for an EVM Type 2 transaction with
   // <1 calldata word, 0 access-list entries, 0 storage keys> and
   // 34-byte serialisation schemas.
   export ledger signBidirectionalEventMap: SignBidirectionalEventMap<EvmType2TxParams<1, 0, 0>, 34, 34>;

   // Required: The Signet singleton signer interface, set at deploy.
   // Used to notify the MPC of events you add to your signBidirectionalEventMap.
   sealed ledger signetSigner: SignetSigner;

   // Required: This contract's MPC response key, set in step 4.
   // Used to verify RespondBidirectionalEvents attesting the serialised output of foreign chain execution.
   export ledger mpcResponseKey: Secp256k1Point;

   // Recommended: contract-local source of request nonces, so identical
   // requests hash to distinct request ids. Nothing off-chain reads it.
   export ledger signetRequestNonce: Counter;

   // Recommended: used in step 4 to ensure initialisation runs only once.
   export ledger initialised: Counter;

   // Recommended: set on deploy, used in step 4 to ensure only the deployer may set the mpcResponseKey.
   sealed ledger deployer: Bytes<32>;

   // Recommended: supplies the deployer's identity secret from private state
   // off-chain. Only its commitment (below) ever reaches the ledger.
   witness witnessDeployerSecretKey(): Bytes<32>;

   // Recommended: the deployer identity commitment scheme. Exported so deploy
   // tooling can compute the constructor argument by calling the compiled circuit.
   export pure circuit calculateDeployerCommitment(sk: Bytes<32>): Bytes<32> {
     return persistentHash<Vector<2, Bytes<32>>>([pad(32, "my-contract:deployer:"), sk]);
   }

   // Required: set signet contract and (recommended) deployer commitment on deployment.
   constructor(signetContract: SignetSigner, deployerCommitment: Bytes<32>) {
     signetSigner = disclose(signetContract);
     deployer = disclose(deployerCommitment);
   }
   ```

4. Set the contract's MPC response key once, right after deploy. Deriving this key requires the address of the contract, which only exists after deploy (see [Response key](#response-key)):

   ```compact
   export circuit initialise(responseKey: Secp256k1Point): [] {
     // Recommended: confirm that only the deployer may initialise, and only once:
     assert(deployer == calculateDeployerCommitment(witnessDeployerSecretKey()), "Not the deployer");
     assert(initialised == 0, "Already initialised");
     initialised.increment(1);

     // Required: set MPC response key for verification of RespondBidirectionalEvents
     mpcResponseKey = disclose(responseKey);
   }
   ```

## Runtime

Each interaction with your contract that executes a transaction on a foreign chain runs these 5 steps.

Steps 1 and 5 are circuits on your contract, and steps 2 to 4 are off-chain client code built on the utilities in `@sig-net/midnight`.

The off-chain steps share one `SignetRequestResponseReader` over your contract / Signet singleton pair, and the expected signer of the requested transaction (the key the MPC derives for your contract and the request's path, see [Derived keys](#derived-keys)):

```ts
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { deriveEvmAddress, SignetRequestResponseReader } from "@sig-net/midnight";

// SignetRequestResponseReader to poll for Signed Transactions and Signed RespondBidirectionalEvents
const reader = new SignetRequestResponseReader({
   // Address of YOUR deployed contract
   requesterContractAddress: myContractAddress,

   // signBidirectionalEventMap's field position (Setup step 3)
   requesterRequestsIndexField: 0,

   // Address of the Signet singleton contract
   signetContractAddress,

   // Provider to index Midnight Blockchain
   publicDataProvider: indexerPublicDataProvider({
      queryURL: indexerUrl,
      subscriptionURL: indexerWsUrl
   }),
});

const expectedSigner = deriveEvmAddress(mpcRootPublicKey, myContractAddress, "my-path");
```

1. Store a signature request and notify the MPC via cross contract call:

```compact
// Construct SignBidirectionalEvent signature request and calculate its RequestId
const request = constructSignBidirectionalEvent<EvmType2TxParams<1, 0, 0>, 34, 34>(/* ... */);
const requestId = disclose(calculateRequestId<EvmType2TxParams<1, 0, 0>, 34, 34>(request));

// Store the signature request in your signBidirectionalEventMap for MPC to discover
signetRequestNonce.increment(1);
signBidirectionalEventMap.insert(requestId, disclose(request));

// Notify the MPC of the SignBidirectionalEvent and the location of your signBidirectionalEventMap.
// The location is 0 here based on the position of the declaration in Setup step 3.
signetSigner.signBidirectional(
   requestId,
   constructSignBidirectionalEventNotificationV1(kernel.self(), 0 as Uint<8>),
);
```

**NOTE:** `requestId` should be returned from the above circuit call so that it may be used in subsequent steps (or compute it off-chain with the `calculateRequestId` TS twin).

2. Poll the Signet singleton for the MPC's signature response. The response log is unauthenticated (anyone can post), so use the verifying getter: it only returns a post whose signature recovers to `expectedSigner` over the requested transaction's signing hash:

   ```ts
   const { verified } = await reader.getVerifiedSignatureRespondedEvent(requestId, expectedSigner);
   // verified === undefined: no valid response posted yet, poll again.
   ```

3. Construct the signed transaction and submit it to the foreign chain. The reader rebuilds the transaction from the request record on your ledger and attaches the verified MPC signature:

   ```ts
   import { JsonRpcProvider } from "ethers";

   const signedTx = await reader.getSignedEvmTransaction(requestId, expectedSigner);
   await new JsonRpcProvider(foreignChainRpcUrl).broadcastTransaction(signedTx.serialized);
   ```

4. Poll the Signet singleton for the MPC's attestation of the remote execution output (posted once the MPC observes the transaction execute on the foreign chain). The event carries the MPC's signature alone: both the attestation digest and the serialised output itself travel off chain (you broadcast the transaction in step 3, so you can read its result). The log is unauthenticated, so use the verifying getter, as in step 2: it recomputes the digest over the output you present and returns only a post whose signature verifies against your contract's response key.

   ```ts
   const respondBidirectionalEvent = await reader.getVerifiedRespondBidirectionalEvent(
      requestId,
      serializedOutput,
      mpcResponseKey,
   );
   // undefined: no attestation of that output posted yet, poll again.
   ```

5. Deliver the response and the serialised output to your contract, which recomputes the attestation digest, verifies the event in-circuit against the response key pinned in Setup step 4, and consumes the request. The width argument is the exact packed size of your respond serialisation schema (a single bool packs to 1 byte):

   ```compact
   assert(
      verifyRespondBidirectionalEvent<1>(requestId, serializedOutput, respondBidirectionalEvent, mpcResponseKey),
      "Invalid attestation signature"
   );
   signBidirectionalEventMap.remove(requestId);
   ```

## More Examples:

For full integration examples (such as an ERC20 cross chain vault) see the [`sig-net/midnight-examples`](https://github.com/sig-net/midnight-examples) repository.

# Contributor Guide

Get set up for contributing by getting both test layers green: the offline unit tests, then the end to end integration suites.

## Compiling, Building and Running Unit Tests

Packages can be compiled (with or without generating zk keys), built and unit tested either independently or together. Only the packages with contracts that run in integration tests have a zk compile option. Unit tests run offline against a simulated Midnight runtime, so zk keys are not needed before running them. From the root of the repository:

```sh
## --- All packages ---

# Quick compile: all packages (checks syntax and generates circuits)
# Runs the compact compiler for each package without generating zk keys (compiler output in the package's src/managed/)
yarn compile

# Longer compile: all packages that require zk keys (checks syntax, generates circuits and zk keys)
# Runs the compact compiler with zk keys for each package that has a :zk option (compiler output in the package's src/managed/)
yarn compile:zk

# Test: all packages (typecheck + unit tests: offline simulator-only)
# Requires 'yarn compile' to have been run (zk keys not required for unit testing).
yarn test

# Build: all packages
# Requires both 'yarn compile' and 'yarn compile:zk': packages that ship
# zk keys refuse to build without them.
yarn build

## --- Independently (for example) ---

# The signet-contract package:
yarn compile:signet-contract
yarn compile:signet-contract:zk  # generates signet-contract zk keys
yarn test:signet-contract        # requires at least 'yarn compile:signet-contract'
yarn build:signet-contract       # requires 'yarn compile:signet-contract:zk'

# The signet-midnight package:
yarn compile:signet-midnight  # NOTE: no :zk option
yarn test:signet-midnight     # requires 'yarn compile:signet-midnight'
yarn build:signet-midnight    # requires 'yarn compile:signet-midnight'
```

> **NOTE:** A build error about missing prover keys (for example "no prover keys in src/managed/keys") means the package's zk compile has not been run yet: run the associated `compile:...:zk` script to generate them.

## Integration Tests

Two end to end suites run against the local docker stack. The generic suite drives the smallest possible client (the test caller [contract](./packages/test-caller-contract/src/test-caller-contract.compact)) through the protocol: submit a signature request, get discovered via the notification registry, receive the MPC signature, and verify it in-circuit. The real-EVM suite carries on past signing: it broadcasts the signed call to the local anvil chain, lets the fakenet observe the mined execution and post its attestation, fetches the raw output from the fakenet's `/responses` helper API, picks the attestation that verifies over the bytes it recomputed, and verifies it in-circuit. Get them running locally:

1. Ensure you have all of the [prerequisites](#prerequisites) installed.
2. From the repository root, install workspace dependencies, select the required Compact toolchain explicitly, and compile:
   ```sh
   corepack enable
   yarn install
   compact update 0.33.0-rc.2   # Exact version required.
                                # `compact update` installs/downgrades
                                # to stable.
   yarn compile
   ```
3. Start the local stack (Midnight node, indexer, proof server, anvil EVM) with `docker compose up -d`. The fakenet MPC responder is started automatically by the test setup once the signet contract is deployed.
4. Run the suites and watch them go. The first run can take **~10–25 minutes** (it generates zk proving keys for both contracts, deploys them and hands off to the fakenet responder, all automatically, no `.env` inserts needed):
   ```sh
   yarn test:integration-tests                          # both suites, requires 'yarn compile'
   yarn test:integration-tests:signet-caller-e2e        # generic caller flow only, requires 'yarn compile'
   yarn test:integration-tests:signet-caller-evm-e2e    # real-EVM flow only, requires 'yarn compile'
   ```
   Whichever selection you run, the setup pipeline runs first (narrowing the selection never skips setup). Green looks like every test in the selected flow files passing. Afterwards, save the printed `MIDNIGHT_CALLER_CONTRACT_ADDRESS` into `.env` so the next run skips compile and deploy (~2 minutes). The signet contract address is appended to `.env` automatically.

**TIP:** If you are using Claude Code you can ask it to do all of this for you using this [skill](.claude/skills/e2e/SKILL.md), for example:
```
Use your /e2e skill to get the integration suite running for me, from fresh clone to green. Recover the run yourself if anything fails along the way.
```

**NOTE:** The most common reason that a run fails is the proof server hanging or crashing when it exhausts memory on a proving leg. This most often presents as the test failing with `connect ECONNREFUSED 127.0.0.1:6300`, with `docker ps -a` showing the proof server container as `Exited (137)`, i.e. OOM-killed. If this happens, restart the proof server and rerun. With the contract addresses kept in `.env` the rerun skips straight to the flow.

# Prerequisites

| Prerequisite | Version | Check With | Where to Get It |
| ------- | ------| ------  |----------- |
| Node | ≥ 20 (22+ recommended) | `node --version` | [nodejs.org](https://nodejs.org) or your version manager (nvm, fnm, …) |
| Yarn 4 (via Corepack) | 4.x | `corepack enable && yarn --version` | Corepack ships with Node, and the repo's `packageManager` field pins the Yarn version |
| Compact toolchain | compiler 0.33.0-rc.2, invoked with `--feature-zkir-v3` (see note) | `compact compile --version` → `0.33.0` | Install the `compact` launcher per [Midnight's docs](https://docs.midnight.network/), then `compact update 0.33.0-rc.2` (compiler builds live at [LFDT-Minokawa/compact releases](https://github.com/LFDT-Minokawa/compact/releases)). If the launcher refuses the rc version, use the direct-download recipe in [.github/workflows/ci.yml](.github/workflows/ci.yml) |
| A docker environment | any recent engine | `docker --version` | [Docker Desktop](https://www.docker.com/products/docker-desktop/) (macOS/Windows) or your distro's engine, with **≥ 16 GB RAM allocated** (see note) |
| Docker Compose v2 | ≥ 2.x | `docker compose version` | Included with Docker Desktop (plugin package on Linux) |

**NOTE:** every `compact compile` against this stack must pass the `--feature-zkir-v3` flag: it is part of the pinned ledger-9 matched set (compiler, node, indexer, proof server), and output compiled without it is not compatible with that stack. This repository's compile scripts already pass it. Integrators compiling their own contracts must pass it themselves (as shown in the [Integrator Guide](#integrator-guide)).

**NOTE:** the midnight proof server is quite heavy. It is recommended that you allocate at least 16 GB of RAM to your docker environment, otherwise expect to have to restart the tests as the proof server hangs.

## Matched set

These versions move together. Bumping one alone produces a stack that compiles but does not interoperate, and the failure is usually silent: a responder that does not recognise a request simply never answers it.

| Component | Version | Pinned in |
| ------- | ------ | ------ |
| `@sig-net/*` npm packages | 0.13.0 | [`packages/*/package.json`](packages) |
| fakenet MPC responder | `ghcr.io/sig-net/fakenet:0.8.0` | [`docker-compose.yaml`](docker-compose.yaml) |
| Compact compiler | 0.33.0-rc.2, invoked with `--feature-zkir-v3` | [`.github/workflows/ci.yml`](.github/workflows/ci.yml), [`.github/workflows/publish.yml`](.github/workflows/publish.yml) |
| Midnight node | 2.0.0-rc.4 | [`docker-compose.yaml`](docker-compose.yaml) |
| Midnight indexer | 4.4.0-pre-alpha.16 (`l91r3-n2r3` build) | [`docker-compose.yaml`](docker-compose.yaml) |
| Midnight proof server | 9.0.0-rc.5_experimental | [`docker-compose.yaml`](docker-compose.yaml) |
| `@midnightntwrk/ledger-v9` | 1.0.0-rc.3 | [`package.json`](package.json) resolutions |

**NOTE:** each fakenet release names the `@sig-net` version it was built against ([`fakenet-v*` tags](https://github.com/sig-net/solana-signet-program/tags)). `fakenet:0.8.0` is built against 0.13.0 and serves the public `/responses/{requestId}` helper API on port 3040 (mapped by [`docker-compose.yaml`](docker-compose.yaml)), from which the integration tests fetch each request's raw traced EVM output.

# Packages

| Package | npm | What it is |
|---|---|---|
| [`packages/signet-midnight`](packages/signet-midnight) | `@sig-net/midnight` | Client-agnostic signet protocol library: shared Compact modules, TS twins of the wire structs, state readers, request feed/resolver, crypto (epsilon derivation, secp256k1 ECDSA attestations) |
| [`packages/signet-contract`](packages/signet-contract) | `@sig-net/midnight-contract` | The central singleton contract: unverified counted response logs + request-notification registry |
| [`packages/signet-contract-deploy`](packages/signet-contract-deploy) | `@sig-net/midnight-contract-deploy` | Deploy tooling for the singleton + the generic deploy/wallet plumbing |
| [`packages/midnight-serde`](packages/midnight-serde) | `@sig-net/midnight-serde` | TypeScript twin of Compact's builtin `serialize<T,N>`/`deserialize<T,N>` byte layout, pinned byte-for-byte against compiled fixture circuits. Zero runtime dependencies |
| [`packages/test-caller-contract`](packages/test-caller-contract) | repo-private | Integration-testing caller contract: submit a signature request, verify the response, the smallest thing that drives the protocol. Testing only, not an integration example |
| [`packages/test-caller-contract-20-field`](packages/test-caller-contract-20-field) | repo-private | Integration-testing caller contract: the 20-field lockstep fixture proving the raw ledger readers resolve field numbers through the compiler's chunked (>15-field) state layout. Testing only |
| [`packages/integration-tests`](packages/integration-tests) | repo-private | The generic e2e suite: submit → notification → MPC signature → in-circuit verify, against the local docker stack (`docker-compose.yaml`: midnight node/indexer/proof server + anvil EVM + fakenet MPC responder) |
| [`packages/lib`](packages/lib) | repo-private | Shared midnight-js provider adapters |
