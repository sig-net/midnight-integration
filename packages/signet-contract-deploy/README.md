# @sig-net/midnight-contract-deploy

Deploy tooling for the central [Sig Network](https://sig.network) signet contract on the [Midnight blockchain](https://midnight.network), self-contained for npm:

- **The operator deploy flow** (`deploySignetContract`): builds, balances, proves and submits the signet contract's deploy transaction through a synced wallet, using the compiled assets shipped in [`@sig-net/midnight-contract`](https://www.npmjs.com/package/@sig-net/midnight-contract).
- **The Node binding** of `@sig-net/midnight-contract` to its compiled assets (zk config, private state).
- **Generic deploy plumbing** any Compact contract's deploy script composes: the deploy config, unproven-transaction build, and funding primitives (a root wallet funds role wallets and registers NIGHT for dust generation). The wallet itself (interface, in-process implementation, seed parsing, key derivation, network config) comes from [`@sig-net/midnight-wallet`](https://www.npmjs.com/package/@sig-net/midnight-wallet) and is re-exported from this package's root.

## Install

```sh
npm install @sig-net/midnight-contract-deploy
```

## Configuration

Everything is read from the environment:

| Variable | Purpose |
|---|---|
| `NETWORK_ID` | Target network: `undeployed` (local stack, the default), `stagenet`, `preview`, `preprod` or `mainnet`. Selects the default endpoints. |
| `MIDNIGHT_NODE_URL`, `MIDNIGHT_NODE_INDEXER_URL`, `MIDNIGHT_NODE_INDEXER_WS_URL`, `MIDNIGHT_NODE_PROOF_SERVER_URL` | Optional per-endpoint overrides of the network defaults. |
| `DEPLOYER_SEED` | The deploying wallet's seed (hex or mnemonic), for an in-process wallet. On the local stack it defaults to the pre-funded genesis mint wallet. |
| `DEPLOYER_REMOTE_WALLET_URL` | Base URL of a hosted deployer wallet speaking `@sig-net/midnight-wallet`'s remote-wallet HTTP protocol (e.g. `https://host/wallet/v1`). The host must be on the deploy's target network. |

The deployer wallet source is exactly one of `DEPLOYER_SEED` and `DEPLOYER_REMOTE_WALLET_URL`: setting both is refused, and a deployed network with neither is refused too (the local stack falls back to the genesis mint seed).

## Usage

```ts
import { deploySignetContract } from "@sig-net/midnight-contract-deploy";

const { contractAddress, txId } = await deploySignetContract(process.env);
```

The generic plumbing (deploy config, unproven-tx build, funding, and the whole of `@sig-net/midnight-wallet`) is exported from the package root as well, for deploy scripts of other Compact contracts.

## Related packages

- [`@sig-net/midnight-contract`](https://www.npmjs.com/package/@sig-net/midnight-contract): the contract this package deploys.
- [`@sig-net/midnight-wallet`](https://www.npmjs.com/package/@sig-net/midnight-wallet): the wallet the deploy flow runs through.
- [`@sig-net/midnight`](https://www.npmjs.com/package/@sig-net/midnight): the client-agnostic protocol library.

Developed in [sig-net/midnight-integration](https://github.com/sig-net/midnight-integration). Example applications live in [sig-net/midnight-examples](https://github.com/sig-net/midnight-examples).
