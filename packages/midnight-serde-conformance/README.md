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
