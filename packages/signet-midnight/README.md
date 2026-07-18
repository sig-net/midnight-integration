# @sig-net/midnight

The client-agnostic [Sig Network](https://sig.network) protocol library for the [Midnight blockchain](https://midnight.network), and the seed of a future signet.js Midnight adapter. It carries everything a Midnight contract or off-chain client needs to speak the signet protocol (the MPC's [sign bidirectional flow](https://docs.sig.network/architecture/sign-bidirectional)) without binding to any particular contract.

## What is in it

- **Shared Compact modules**: the package ships its `.compact` sources, so contracts import them directly:
  ```compact
  import "@sig-net/midnight/src/Signet";
  ```
- **Compiled pure circuits** (`pureCircuits`): the executable reference implementation of the client-agnostic circuits (path/identity checks, the attestation message, the sign-bidirectional notification packer, the Schnorr challenge). Off-chain code calls these compiled artefacts instead of re-porting the algorithms, so it always agrees with what the contracts prove.
- **TypeScript twins of the wire structs** and signet request-id computation.
- **State readers, request feed and resolver**: poll the signet contract for pending requests and their signature / remote-execution responses.
- **Crypto helpers**: epsilon derivation and Jubjub Schnorr response verification.

Where signet.js already covers something (for example EVM transaction preparation or address derivation), import it from there; only what is Midnight-specific lives here.

## Install

```sh
npm install @sig-net/midnight
```

## Related packages

- [`@sig-net/midnight-contract`](https://www.npmjs.com/package/@sig-net/midnight-contract): the central signet contract this library reads from.
- [`@sig-net/midnight-contract-deploy`](https://www.npmjs.com/package/@sig-net/midnight-contract-deploy): deploy tooling for that contract plus generic Midnight deploy/wallet plumbing.

Developed in [sig-net/midnight-integration](https://github.com/sig-net/midnight-integration); example applications live in [sig-net/midnight-examples](https://github.com/sig-net/midnight-examples).
