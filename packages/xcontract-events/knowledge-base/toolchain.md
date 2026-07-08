# Toolchain & compilation (compactc 0.33)

Back to [`index.md`](index.md) · related: [`gotchas.md`](gotchas.md)

## Versions (confirm on any machine)

```bash
compact --version                 # → compact 0.5.1        (the CLI wrapper)
compact compile --version         # → 0.33.0               (the actual compiler, compactc)
compact list                      # installed compiler versions
# deeper, via the compiler binary directly:
~/.compact/versions/0.33.0-rc.0/*/compactc.bin --language-version   # → 0.25.0
~/.compact/versions/0.33.0-rc.0/*/compactc.bin --ledger-version     # → ledger-9.1.0.0-rc.2
~/.compact/versions/0.33.0-rc.0/*/compactc.bin --runtime-version    # → 0.18.0-rc.0
```

- **Language version 0.25.0** is the max `pragma language_version` compactc 0.33 accepts.
  All contracts here start `pragma language_version >= 0.25;`.
- The compiler is installed under `~/.compact/versions/<ver>/<arch>/` (binaries: `compactc`,
  `compactc.bin`, `zkir`, `zkir-v3`, `format-compact`, `fixup-compact`). The
  `CompactStandardLibrary` is embedded in `compactc.bin` (no `.compact` stdlib file on disk).

## Compile commands

Pattern (one `.compact` source → one `managed/` output dir):
```bash
# fast, no proving keys — enough for TS typecheck + in-process simulator:
COMPACT_PATH=../../node_modules compact compile --skip-zk src/X.compact src/managed/X
# full — generates prover/verifier keys; REQUIRED to deploy or prove:
COMPACT_PATH=../../node_modules compact compile        src/X.compact src/managed/X
```
- `COMPACT_PATH` = where the compiler resolves `import "..."` module paths (workspace
  `node_modules`). Not needed if you only `import CompactStandardLibrary;`.
- This package compiles **two** contracts into **two** dirs — see
  [`package.json`](../package.json) scripts `compile`, `compile:zk` (each calls
  `compile:token[:zk]` + `compile:vault[:zk]`).
- `managed/` is git-ignored (regenerated); see [`.gitignore`](../.gitignore).

## `compactc` flags worth knowing (`compactc.bin --help`)

| Flag | Effect |
|---|---|
| `--skip-zk` | Skip proving-key generation (fast). Leaves `expectedVk = {}` — see below. |
| `--no-communications-commitment` | Omit the commitment that gives **contract-to-contract call** data integrity. Leave ON. |
| `--feature-zkir-v3` | Emit ZKIR v3 (default v2). |
| `--language-version` / `--ledger-version` / `--runtime-version` | Print versions and exit. |
| `--vscode` | Single-line error messages. |

## `managed/` output layout

```
managed/<name>/
  contract/index.js        # the JS contract impl (Contract class, circuits, ledger(), pureCircuits)
  contract/index.d.ts      # TS types — read this to learn a circuit's exact TS signature
  contract/index.js.map
  zkir/<circuit>.zkir       # (+ .bzkir with full compile) — the arithmetic circuit
  keys/<circuit>.prover     # ONLY present after a full (non --skip-zk) compile
  keys/<circuit>.verifier   # ditto
  compiler/contract-info.json, contract-manifest.json
```

- **`--skip-zk` ⇒ no `keys/`, and `expectedVk = {}`** in `index.js`. A full compile populates
  `keys/*` and `expectedVk = { <circuit>: '<sha256 of verifier key>' }`. That `expectedVk`
  hash is exactly what the cross-contract `ZKConfigRegistry` joins on. **You must
  `compile:zk` before deploying or proving** (see [gotcha #3](gotchas.md#3) neighbor: missing
  keys ⇒ deploy/prove fail).
- Contract **A** does NOT import contract **B**'s source. A's `contract Token {…}` block is a
  self-contained external declaration; the two compile independently.

## Reading a circuit's TS signature

The generated `index.d.ts` is the source of truth for how TS calls a circuit and what the
constructor expects. E.g. a contract-reference constructor arg shows up as
`{ bytes: Uint8Array }` and a ledger field of contract type reads back the same shape.
`ledger(state)` returns the decoded ledger; `pureCircuits.<name>(...)` runs pure circuits
without a context.

## Probe the compiler (do this instead of trusting docs)

Docs/architecture proposals describe features that are only partially implemented. When
unsure, write a tiny `.compact` and compile it — the error messages are precise and teach the
real grammar. Example loop used during this research:

```bash
cd $(mktemp -d)
cat > t.compact <<'EOF'
pragma language_version >= 0.25;
import CompactStandardLibrary;
export circuit e(): [] { emit (Misc { name: pad(32,"x"), payload: default<Bytes<256>> }); }
EOF
compact compile --skip-zk t.compact out
```

Findings that came straight from compiler errors (all in [`gotchas.md`](gotchas.md)): the
`event` keyword is reserved; `emit` rejects a plain struct; `Cell` is not a bare identifier;
`Counter.increment` wants `Uint<16>`; external circuit decls need the `circuit` keyword;
`disclose` is mandatory for param/witness→ledger writes.
