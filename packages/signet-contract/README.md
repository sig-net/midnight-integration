# @sig-net/midnight-contract

The central [Sig Network](https://sig.network) signet contract on the [Midnight blockchain](https://midnight.network): the singleton that exposes the MPC's [sign bidirectional flow](https://github.com/sig-net/midnight-integration#sign-bidirectional-flow) to other Midnight contracts. Every circuit emits a named contract event: the MPC posts back through the contract, and clients poll its events:

- **Signature responses**: an unauthenticated event log. Each event carries the request id it answers as routing data. Callers read their request's posts by id and verify the signatures off-chain or in their own circuits: the verification is what separates a genuine post from garbage.
- **Remote execution responses**: secp256k1 ECDSA attestations by the MPC's per-client response key, emitted unverified like the signature responses. The client contract verifies them in its own circuit.
- **Request-notification events**: how the MPC discovers new signature requests (each event declares the stored request's id and names the caller contract and the ledger path of its request map).

## What is in it

- The curated export surface (package root): the generated contract module (`Contract`), the handwritten witnesses, and the platform-agnostic contract surface (circuit ids and the provider type).
- The `./managed/*` subpath export: the compiled contract assets (compiler output, `zkir/`, prover/verifier `keys/`) so runtimes can fetch them as files. The published package always carries the proving keys.

Consumers import the package root. The `./managed/*` paths exist only for runtimes that load zk assets.

## Install

```sh
npm install @sig-net/midnight-contract
```

## Related packages

- [`@sig-net/midnight-contract-deploy`](https://www.npmjs.com/package/@sig-net/midnight-contract-deploy): deploys this contract (constructor argument: the MPC attestation key).
- [`@sig-net/midnight`](https://www.npmjs.com/package/@sig-net/midnight): the client-agnostic protocol library for reading this contract's state and verifying responses.

Developed in [sig-net/midnight-integration](https://github.com/sig-net/midnight-integration). Example applications live in [sig-net/midnight-examples](https://github.com/sig-net/midnight-examples).
