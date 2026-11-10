# @sig-net/midnight-contract-deploy

Deploy tooling for the [Sig Network](https://sig.network) protocol contracts on the [Midnight blockchain](https://midnight.network), the central signet signer and the signet responder, self-contained for npm:

- **The operator deploy flows** (`deploySignetSigner`, `deploySignetResponder`): build, balance, prove and submit the contract's deploy transaction through a synced wallet, using the compiled assets shipped in [`@sig-net/midnight-signer`](https://www.npmjs.com/package/@sig-net/midnight-signer) or [`@sig-net/midnight-responder`](https://www.npmjs.com/package/@sig-net/midnight-responder).
- **The Node bindings** of `@sig-net/midnight-signer` and `@sig-net/midnight-responder` to their compiled assets (zk config, private state).
- **Generic deploy/wallet plumbing** any Compact contract's deploy script composes: network config, seed parsing and key derivation, the wallet facade lifecycle, funding primitives (a root wallet funds role wallets and registers NIGHT for dust generation), and unproven-transaction build/submit.

## Install

```sh
npm install @sig-net/midnight-contract-deploy
```

## Configuration

Everything is read from the environment:

| Variable | Purpose |
|---|---|
| `NETWORK_ID` | Target network: `undeployed` (local stack, the default), `preview`, `preprod` or `mainnet`. Selects the default endpoints. |
| `MIDNIGHT_NODE_URL`, `MIDNIGHT_NODE_INDEXER_URL`, `MIDNIGHT_NODE_INDEXER_WS_URL`, `MIDNIGHT_NODE_PROOF_SERVER_URL` | Optional per-endpoint overrides of the built-in endpoints. Setting both the node and the indexer URL reaches a node and indexer you run, on any network. The indexer WS URL derives from the indexer URL when unset. |
| `BLOCKFROST_PROJECT_ID` | Required on `preprod` and `mainnet` unless both the node and the indexer URL are set. Blockfrost serves the public node and indexer of those two networks and answers only requests that carry a project token: create a "Midnight Preprod" or "Midnight Mainnet" project at [blockfrost.io](https://blockfrost.io) and use its project id. A token works on its own network only. It is a secret, and it travels in the node and indexer URLs, which this package masks in everything it logs. |
| `DEPLOYER_SEED` | The deploying wallet's seed (hex or mnemonic). On the local stack it defaults to the pre-funded genesis mint wallet. |
| `MIDNIGHT_SIGNER_CONTRACT_ADDRESS` | Optional on a deployed network: the signet signer a requester contract seals at deploy. `resolveSignerContractAddress` takes the signet signer `@sig-net/midnight` publishes for the network when it is unset, and refuses a set value that disagrees with it. The local stack publishes none, so there it names the signet signer you deployed. |
| `MPC_SECP256K1_PUBKEY` | Optional on a deployed network: the MPC root public key a requester's derived accounts start from, in SEC1 hex or NEAR `secp256k1:<base58>` form. `resolveMpcRootPublicKey` takes the key `@sig-net/midnight` publishes for the network when it is unset, refuses a set value that disagrees with it, and returns `0x04…` uncompressed hex either way. |
| `MIDNIGHT_FAUCET_URL` | The faucet named in the unfunded-wallet hint. Built in per network: preview `https://midnight-tmnight-preview.nethermind.dev`, preprod `https://midnight-tmnight-preprod.nethermind.dev`. Set it to override one of those, or to name a faucet for a network without one. |

In a checkout of the [sig-net/midnight-integration](https://github.com/sig-net/midnight-integration) repository, `yarn deploy:signet-signer` and `yarn deploy:signet-responder` also load the repository root's `.env` file whenever one exists. A variable already set in the shell takes precedence over the same key in the file.

## Usage

```ts
import { deploySignetSigner, deploySignetResponder } from "@sig-net/midnight-contract-deploy";

const signet signer = await deploySignetSigner(process.env);
const responder = await deploySignetResponder(process.env);
```

Each returns the deployed `contractAddress` and the deploy transaction's `txId`.

The generic plumbing (network config, wallets, funding, transaction submission) is exported from the package root as well, for deploy scripts of other Compact contracts.

A pipeline that touches several wallets, or one wallet several times, holds them in a `WalletRegistry`: the first request for a seed builds, starts and fully syncs its facade (on a deployed network a fresh facade scans the chain from nothing, and the sync logs a heartbeat with each sub-wallet's position every ten seconds), every later request returns the same running facade, and `close()` stops them all once. `deploySignetSigner(env, wallets)`, `deploySignetResponder(env, wallets)` and the funding primitives (`assertRootFunded`, `readAccountFunding`, `fundChildFromRoot`) take the registry. Without one, each deploy flow opens a private registry for its single wallet and closes it after.

## Deploying from CI

The [sig-net/midnight-integration](https://github.com/sig-net/midnight-integration) repository deploys the signet signer and the responder through its manually dispatched `deploy` workflow, which picks a contract, a network and a release tag and runs that contract's flow on a runner with a local proof server.

- **The wallet needs faucet-funded NIGHT and nothing else.** The flow registers that NIGHT for dust generation and waits for the first spendable DUST, so a freshly funded seed works on the first run. A run whose wallet holds no NIGHT yet fails printing the wallet's NIGHT receive address (`mn_addr…`) and the network's faucet URL, ready to paste into the faucet.
- **The deployed address is recorded by a bot PR.** The workflow writes it into the contract's address table (`signerContractAddresses` or `responderContractAddresses`) of [`@sig-net/midnight`](https://www.npmjs.com/package/@sig-net/midnight) and opens a pull request, so a human reviews the address before it ships to npm consumers.
- **A deploy sets NO contract maintenance authority.** The maintenance signing key is sampled and dropped, so a deployed contract can never be updated: every run creates a fresh, permanent contract instance, and moving forward means a new deployment while the existing contracts stay exactly as they are.

## Documentation

The deployed contracts are the signet signer and the responder of the [sign bidirectional flow](https://github.com/sig-net/midnight-integration/blob/main/README.md#sign-bidirectional-protocol-flow), documented in the [sig-net/midnight-integration README](https://github.com/sig-net/midnight-integration/blob/main/README.md).

## Related packages

- [`@sig-net/midnight-signer`](https://www.npmjs.com/package/@sig-net/midnight-signer) and [`@sig-net/midnight-responder`](https://www.npmjs.com/package/@sig-net/midnight-responder): the contracts this package deploys.
- [`@sig-net/midnight`](https://www.npmjs.com/package/@sig-net/midnight): the client-agnostic protocol library.

Developed in [sig-net/midnight-integration](https://github.com/sig-net/midnight-integration). Example applications live in [sig-net/midnight-examples](https://github.com/sig-net/midnight-examples).
