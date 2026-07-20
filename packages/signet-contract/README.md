# @sig-net/midnight-contract

The central [Sig Network](https://sig.network) signet contract on the [Midnight blockchain](https://midnight.network): the singleton that exposes the MPC's [sign bidirectional flow](https://docs.sig.network/architecture/sign-bidirectional) to other Midnight contracts. The MPC posts back to it and clients poll it:

- **Signature responses**: an unauthenticated counted log; callers verify the signatures off-chain or in their own circuits.
- **Remote execution responses**: secp256k1 ECDSA attestations by the MPC's key, verified in-circuit at post time.
- **Request-notification registry**: how the MPC discovers new signature requests.

## What is in it

- The curated export surface (package root): the generated contract module (`Contract`, the `ledger` state decoder, `pureCircuits`), the handwritten witnesses, and the platform-agnostic contract surface (circuit ids and the provider type).
- The `./managed/*` subpath export: the compiled contract assets (compiler output, `zkir/`, prover/verifier `keys/`) so runtimes can fetch them as files. The published package always carries the proving keys.

Consumers import the package root; the `./managed/*` paths exist only for runtimes that load zk assets.

## Install

```sh
npm install @sig-net/midnight-contract
```

## Related packages

- [`@sig-net/midnight-contract-deploy`](https://www.npmjs.com/package/@sig-net/midnight-contract-deploy): deploys this contract (constructor argument: the MPC attestation key).
- [`@sig-net/midnight`](https://www.npmjs.com/package/@sig-net/midnight): the client-agnostic protocol library for reading this contract's state and verifying responses.

Developed in [sig-net/midnight-integration](https://github.com/sig-net/midnight-integration); example applications live in [sig-net/midnight-examples](https://github.com/sig-net/midnight-examples).
