# @midnight-protocol/midnight-serde-conformance

Repo-private conformance kit for Compact's builtin `serialize<T, N>` /
`deserialize<T, N>` byte layout. It owns everything every midnight-serde
implementation is pinned against:

- [`serde-fixtures.compact`](serde-fixtures.compact): the fixture contract
  wrapping the builtins over every supported type shape. `yarn compile`
  (skip-zk) regenerates the gitignored `managed/` bindings.
- [`src/descriptors.ts`](src/descriptors.ts): the shared descriptor tables and
  fixture values mirroring the contract.
- [`src/oracle.ts`](src/oracle.ts): the `toBinaryRepr` oracle adapter (widths
  computed independently of any twin).
- [`corpus/serde-corpus.jsonl`](corpus/serde-corpus.jsonl): the COMMITTED
  golden corpus. One JSON record per line: a header (compactc version, fixture
  hash, encoding conventions), serialize and deserialize expectations with
  provenance (`circuit` / `oracle` / `twin`), rejection cases by
  language-neutral category, and a 400-case seeded sweep. Uint/Field values
  and bounds travel as decimal strings, bytes as lowercase hex.

The corpus is DERIVED, never hand-edited. `src/generate.ts` builds it from the
compiled circuits, the oracle and the TypeScript twin, and throws unless all
three agree on every record, so the file can only ever be written from an
agreeing triple. The guard test regenerates it in memory on every `yarn test`
and byte-compares against the committed file, so it cannot go stale silently.

After a deliberate fixture or layout change:

```bash
yarn workspace @midnight-protocol/midnight-serde-conformance generate
```

then commit the diff. Treat any diff you did not intend as a layout
regression.

Consumers: `packages/midnight-serde-ts` (imports the circuits, descriptors and
corpus loader for its tests) and `packages/midnight-serde-rs` (reads the
committed corpus file directly, no Node toolchain required).
