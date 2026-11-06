# @sig-net/midnight-contract

The central [Sig Network](https://sig.network) signet contract on the [Midnight blockchain](https://midnight.network): the singleton that exposes the MPC's [sign bidirectional flow](https://github.com/sig-net/midnight-integration/blob/main/README.md#sign-bidirectional-protocol-flow) to other Midnight contracts. Integrating contracts notify it of their requests through `signBidirectional`, which emits a named contract event the MPC polls. The MPC posts its responses to the [signet responder](https://www.npmjs.com/package/@sig-net/midnight-responder), and clients poll that contract's events.

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

- [Sign Bidirectional Flow](https://github.com/sig-net/midnight-integration/blob/main/README.md#sign-bidirectional-protocol-flow): the 5-step protocol this contract starts, with diagram, failure handling and output recovery: which circuit each step calls and which event it emits.
- [Integrator Guide](https://github.com/sig-net/midnight-integration/blob/main/README.md#integrator-guide): how client contracts and dApps drive this contract's `signBidirectional` and read the responder's events per request.
- [Handling Failure](https://github.com/sig-net/midnight-integration/blob/main/README.md#handling-failure): how a failed foreign transaction still completes the flow, attested through the responder's `respondBidirectional` circuit as an empty output under a failure output kind.

## Related packages

- [`@sig-net/midnight-contract-deploy`](https://www.npmjs.com/package/@sig-net/midnight-contract-deploy): deploys this contract (it takes no constructor arguments: the MPC derives a response key per client contract, and each client pins its own).
- [`@sig-net/midnight`](https://www.npmjs.com/package/@sig-net/midnight): the client-agnostic protocol library for decoding this contract's events and verifying the MPC's responses.
- [`@sig-net/midnight-responder`](https://www.npmjs.com/package/@sig-net/midnight-responder): the contract the MPC posts its responses to.

Developed in [sig-net/midnight-integration](https://github.com/sig-net/midnight-integration). Example applications live in [sig-net/midnight-examples](https://github.com/sig-net/midnight-examples).
