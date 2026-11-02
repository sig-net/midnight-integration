# @sig-net/midnight-responder

The [Sig Network](https://sig.network) response contract on the [Midnight blockchain](https://midnight.network): the two circuits the MPC posts its responses through, each emitting them as contract events, which clients poll:

- `respond`: a signature response, as a `SignatureRespondedEvent`.
- `respondBidirectional`: a remote execution attestation, as a `RespondBidirectionalEvent`.

Both circuits emit unverified posts. Clients verify each one themselves, exactly as for the [signet singleton](../signet-contract/README.md)'s events of the same names.

## What is in it

- The curated export surface (package root): the generated contract module (`Contract`), the handwritten witnesses, and the platform-agnostic contract surface (circuit ids and the provider type).
- The `./managed/*` subpath export: the compiled contract assets (compiler output, `zkir/`, prover/verifier `keys/`) so runtimes can fetch them as files. The published package always carries the proving keys.

## Where the proving artifacts come from

[`src/signet-responder.compact`](src/signet-responder.compact) is the specification and the source of the JS executor. The `zkir/` and `keys/` the package ships are compiled from [`minocrab/`](minocrab), the same two circuits written in [MinoCrab](https://github.com/sig-net/minocrab), which prove at k=10/11 instead of compactc's k=16. The fee and the proof size are the same.

`yarn compile:zk` builds that bundle:

1. `yarn compile` writes compactc's `--skip-zk` output to `src/managed/`.
2. `cargo run` in `minocrab/` checks each MinoCrab circuit against compactc's `.zkir` of it: both must accept the call the MPC makes and derive the same public inputs.
3. It replaces compactc's `.zkir` with MinoCrab's, generates the `.bzkir` and the keys with the `zkir-v3` that ships beside compactc, and rewrites `compiler/contract-manifest.json` to list them, which midnight-js checks every artifact against.
4. It fails if any artifact's hash differs from [`minocrab/artifacts.sha256`](minocrab/artifacts.sha256). New hashes mean new verifier keys, which only a new deployment carries. To accept them, run `yarn compile:signet-responder`, then `cargo run --locked -- ../src/managed --update-lock` in `minocrab/`, and commit the lock.

`yarn compile:zk` needs a Rust toolchain; [`minocrab/rust-toolchain.toml`](minocrab/rust-toolchain.toml) pins it. `cargo test` in `minocrab/` runs the same parity checks after `yarn compile`.

## Install

```sh
npm install @sig-net/midnight-responder
```

## Related packages

- [`@sig-net/midnight-contract`](https://www.npmjs.com/package/@sig-net/midnight-contract): the signet singleton, which integrating contracts notify of their requests.
- [`@sig-net/midnight`](https://www.npmjs.com/package/@sig-net/midnight): the client-agnostic protocol library for decoding these events and verifying responses.

Developed in [sig-net/midnight-integration](https://github.com/sig-net/midnight-integration).
