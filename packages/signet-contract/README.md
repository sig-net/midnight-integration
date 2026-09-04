# @sig-net/midnight-contract

The central [Sig Network](https://sig.network) signet contract on the [Midnight blockchain](https://midnight.network): the singleton that exposes the MPC's [sign bidirectional flow](https://github.com/sig-net/midnight-integration/blob/main/README.md#sign-bidirectional-protocol-flow) to other Midnight contracts. Every circuit emits a named contract event: the MPC posts back through the contract, and clients poll its events.

## What is in it

- The curated export surface (package root): the generated contract module (`Contract`), the handwritten witnesses, and the platform-agnostic contract surface (circuit ids and the provider type).
- The `./managed/*` subpath export: the compiled contract assets (compiler output, `zkir/`, prover/verifier `keys/`) so runtimes can fetch them as files. The published package always carries the proving keys.

Consumers import the package root. The `./managed/*` paths exist only for runtimes that load zk assets.

## Install

```sh
npm install @sig-net/midnight-contract
```

## Documentation

The protocol and integration documentation lives in the [sig-net/midnight-integration README](https://github.com/sig-net/midnight-integration/blob/main/README.md):

- [Sign Bidirectional Flow](https://github.com/sig-net/midnight-integration/blob/main/README.md#sign-bidirectional-protocol-flow): the 5-step protocol this contract relays, with diagram, failure handling and output recovery: which circuit each step calls and which event it emits.
- [Integrator Guide](https://github.com/sig-net/midnight-integration/blob/main/README.md#integrator-guide): how client contracts and dApps drive this contract's circuits and events per request.

## Related packages

- [`@sig-net/midnight-contract-deploy`](https://www.npmjs.com/package/@sig-net/midnight-contract-deploy): deploys this contract (constructor argument: the MPC attestation key).
- [`@sig-net/midnight`](https://www.npmjs.com/package/@sig-net/midnight): the client-agnostic protocol library for reading this contract's state and verifying responses.

Developed in [sig-net/midnight-integration](https://github.com/sig-net/midnight-integration). Example applications live in [sig-net/midnight-examples](https://github.com/sig-net/midnight-examples).
