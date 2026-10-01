# Borsh and Compact conformance evidence

This private package checks the documented overlap between native Borsh and Compact standard-library serialisation. Its consumers are the TypeScript Borsh wrapper and the Rust Borsh wrapper. TypeScript tests execute compiler-generated fixture JavaScript with the Compact runtime. Rust tests read the committed fixture bytes without Node or a compiler.

`serde-fixtures.compact` supplies integer, fixed-array, struct, enum, Maybe and Either cases. `src/cases.ts` pairs those compiled bytes with native Borsh schemas and values. `corpus/borsh-corpus.json` records those bytes for Rust replay. The corpus test checks that the non-empty committed corpus matches the compiled fixture outputs. An additional deterministic sweep checks 1000 u128 response values in both circuit directions.

The suite records incompatible cases too: Borsh options, empty arrays in borsh-js, invalid Boolean bytes and narrower Compact integer bounds. These are documentation evidence, not production compatibility checks. No test claims complete Compact coverage or proof-system verification.

From the repository root:

```sh
yarn workspace @midnight-protocol/midnight-serde-conformance compile
yarn workspace @midnight-protocol/midnight-serde-conformance generate
```

Generation is a deliberate fixture update. Review and retain the updated corpus with the source change. The pinned compiler identity protects fixture provenance. The ordinary unit suite checks fixture compatibility and corpus drift. The Rust job replays the corpus once. The separate 1,000-value response sweep runs only when one of the three serde package folders changes in CI and uses the fixtures already compiled by the unit job.

For a local sweep after compilation:

```sh
yarn workspace @midnight-protocol/midnight-serde-conformance test:sweep
```

The verified compiler builds cover macOS and Linux on x64 and arm64. Keep `COMPACTC_VERSION`, `RUNTIME_VERSION` and every `COMPILER_BUILDS` hash in `src/toolchain.ts` aligned with the repository's compiler and runtime pins. Each hash is SHA-256 of `compactc.bin` extracted from that platform's official release archive, not the archive checksum. The selected default compiler must match that verified build.
