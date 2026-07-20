# @sig-net/midnight-contract-deploy

Deploy tooling for the central [Sig Network](https://sig.network) signet contract on the [Midnight blockchain](https://midnight.network), self-contained for npm:

- **The operator deploy flow** (`deploySignetContract`): builds, balances, proves and submits the signet contract's deploy transaction through a synced wallet, using the compiled assets shipped in [`@sig-net/midnight-contract`](https://www.npmjs.com/package/@sig-net/midnight-contract).
- **The Node binding** of `@sig-net/midnight-contract` to its compiled assets (zk config, private state).
- **Generic deploy/wallet plumbing** any Compact contract's deploy script composes: network config, seed parsing and key derivation, the wallet facade lifecycle, funding primitives (a root wallet funds role wallets and registers NIGHT for dust generation), and unproven-transaction build/submit.

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
| `DEPLOYER_SEED` | The deploying wallet's seed (hex or mnemonic). On the local stack it defaults to the pre-funded genesis mint wallet. |
| `MPC_SECP256K1_PUBKEY` | The MPC attestation key, as compressed or uncompressed 0x-hex. The contract seals its hash at deploy time. |

## Usage

```ts
import { deploySignetContract } from "@sig-net/midnight-contract-deploy";

const { contractAddress, txId } = await deploySignetContract(process.env);
```

The generic plumbing (network config, wallets, funding, transaction submission) is exported from the package root as well, for deploy scripts of other Compact contracts.

## Related packages

- [`@sig-net/midnight-contract`](https://www.npmjs.com/package/@sig-net/midnight-contract): the contract this package deploys.
- [`@sig-net/midnight`](https://www.npmjs.com/package/@sig-net/midnight): the client-agnostic protocol library.

Developed in [sig-net/midnight-integration](https://github.com/sig-net/midnight-integration); example applications live in [sig-net/midnight-examples](https://github.com/sig-net/midnight-examples).
