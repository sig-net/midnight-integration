# @midnight-protocol/midnight-serde-conformance

Repo-private conformance kit for Compact's builtin `serialize<T, N>` /
`deserialize<T, N>` byte layout. It owns everything every midnight-serde
implementation is pinned against:

- [`serde-fixtures.compact`](serde-fixtures.compact): the fixture contract
  wrapping the builtins over representative type shapes. `yarn compile`
  (skip-zk) regenerates the gitignored `managed/` bindings.
- [`src/descriptors.ts`](src/descriptors.ts): the shared descriptor tables and
  fixture values mirroring the contract.
- [`src/oracle.ts`](src/oracle.ts): the `toBinaryRepr` oracle adapter (widths
  computed independently of any twin).
- [`corpus/serde-corpus.jsonl`](corpus/serde-corpus.jsonl): the COMMITTED
  golden corpus. One JSON record per line: a header (schema version, compactc
  release, verified compiler binary hashes, runtime version, fixture hash and
  encoding conventions), serialize and deserialize expectations with
  provenance (`circuit` / `oracle` / `twin`), rejection cases by
  language-neutral category, `schema` records, and a 400-case seeded sweep.
  Uint/Field values and bounds travel as decimal strings, bytes as lowercase
  hex.
- [`src/abi-schemas.ts`](src/abi-schemas.ts): the respond-schema cases behind
  the `schema` records: SignBidirectionalEvent's ABI-style JSON schemas
  exactly as carried on chain (including the verbatim Bytes<34>/Bytes<69>
  literals from test-caller-contract.compact and a NUL-padded form). Each
  record carries the schema STRING, the descriptor the production mapping
  (@sig-net/midnight's `respondSchemaDescriptor`) derives from it, and the
  packed bytes: at generation the production encoder
  (`serializeRespondOutput`), the twin and the oracle must all agree.
  Implementations must derive the descriptor from the schema string
  themselves, so the schema-to-descriptor mapping is conformance-tested in
  every language, not just the bytes.

The corpus is derived by `src/generate.ts`. Each record states its authority:
`circuit` means compiler-generated JavaScript was executed, `oracle` means the
runtime FAB adapter, `twin` means an intentional off-chain policy, and
`production` means the production ABI mapping. These are different levels of
evidence. The generator checks the TypeScript implementation against each
record's authority. The guard regenerates and byte-compares the whole file,
checks coverage families and tests deliberate mutations.

Compilation verifies the SHA-256 of `compactc.bin` against the pinned
0.33.0-rc.2 builds for macOS arm64 and Linux x64. The generated identity records
the source, compiler and output hashes and compact-runtime 0.18.0-rc.1.
Regeneration refuses stale source, generated output or identity metadata.
Adding another platform requires verifying and registering its compiler hash.

`Secp256k1Base` and `Secp256k1Scalar` use direct compiler expectations.
Their runtime FAB representation shifts the value by one modulo the field,
so `toBinaryRepr` is not an oracle for their builtin serialisation.

After a deliberate fixture or layout change:

```bash
yarn workspace @midnight-protocol/midnight-serde-conformance generate
```

then commit the diff. Treat any diff you did not intend as a layout
regression.

Consumers: `packages/midnight-serde-ts` (imports the circuits, descriptors and
corpus loader for its tests) and `packages/midnight-serde-rs` (reads the
committed corpus file directly, no Node toolchain required).

## Compiler-backed sweep

From the repository root:

```bash
yarn workspace @midnight-protocol/midnight-serde-conformance test:compiler
```

The sweep generates and compiles separate Compact modules, then compares the
TypeScript codec with the emitted JavaScript. Coverage includes every sized
Uint width from 1 to 248, bounds around byte transitions, all three supported
fields, enum boundaries, representative composites, 400 seeded descriptor
cases, all 65536 two-byte Uint<12> encodings, and every boolean byte with
padding and strictness combinations. Compiler-supported shapes exercise both
directions. The seeded descriptors and compiler-limited nested encoders
exercise the decode direction.

The output `managed-sweep/compiler-corpus.jsonl` is a local artifact consumed
by Rust's ignored `compiler_sweep_conformance` test through the
`MIDNIGHT_SERDE_COMPILER_CORPUS` environment variable. CI generates and replays
it only on pushes or pull requests changing files under
`packages/midnight-serde-conformance`, `packages/midnight-serde-ts` or
`packages/midnight-serde-rs`. The ordinary corpus tests remain part of the
normal unit checks.

These checks execute compiler-generated JavaScript. Proof generation and
Impact VM execution remain outside this suite's evidence.
