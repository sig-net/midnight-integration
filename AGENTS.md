# midnight-erc20-vault — workspace-wide agent rules

This repository is a single **npm workspace**. Its members live under `packages/`:

- **`packages/lib`** — shared runtime plumbing (config, network, providers, wallet,
  logging). The ONLY copy of these files.
- **`packages/signet-midnight`** — the Midnight-side sig-net integration; the point
  of the repo. Seed of a future signet.js Midnight adapter.
- **`packages/vault-contract`** / **`packages/signature-responses-contract`** — one
  package per Compact contract, no contract/sdk split. See "Contract packages" below.
- **`packages/deploy`** — generic Midnight deployer (see its `AGENTS.md`).

Run `npm install` from the repo root — never from inside a member.
Run `npm run compile` once before `build`/`test`: the contract packages AND
`packages/signet-midnight` typecheck against their generated `src/managed/`
output (signet-midnight compiles its Compact module's pure circuits via
`src/circuits.compact` — skip-zk only, no `compile:zk` script on purpose).

This repo is a **bit-by-bit rewrite** of the old
`~/Projects/github.com/sig-net/midnight-erc20-vault` checkout (its `repo-layout.md`
is the design doc). Code is *ported*, not bulk-copied: each ported piece lands with
its tests, and stale parts (dead env vars, websocket code, counter-scaffold
leftovers) are stripped in the process, never carried along.

Member-specific rules live in that member's own `AGENTS.md`.

# NEVER BREAK rules

These are non-negotiable. Do not violate them unless the user explicitly grants an
exception for that specific case.

- **ALWAYS install dependencies at latest; NEVER pin.** Add deps with
  `npm install <pkg>@latest -w <workspace>` so package.json carries a caret range at
  the current version. The compact toolchain is likewise unpinned: `compact update`
  installs it and compile scripts carry **no `+version` pin**. Corollary: a
  dependency shared by two members MUST resolve to the same version in every member
  — bump it everywhere in the same change and `npm install` from the root. A single
  shared version is what keeps the WASM-backed `@midnight-ntwrk/*` packages
  resolving to one instance; divergence causes dual-instance "expected instance
  of…" bugs.
- **NEVER emit JavaScript.** Packages export TypeScript source
  (`"." : "./src/index.ts"`); `build` means `tsc` under the base config's `noEmit`.
  No `dist/`, no `tsc --outDir`, no ts-node loaders, no copy steps. Tests run under
  vitest; entrypoints run under `tsx`. If you think you need a build step, you are
  reintroducing the mess this repo was rebuilt to escape — stop and ask.
- **ALWAYS finish a change with `npm run build && npm run test`** in the member you
  touched (or from the root). `tsx` and vitest execute without typechecking — "it
  runs" is NOT verification. If you add a new top-level TS directory to a member,
  add it to that member's tsconfig `include` in the same change; a file outside
  `include` passes silently and then breaks in the IDE.
- **NEVER commit generated compiler output.** Each contract package's
  `src/managed/` is produced by `npm run compile` and is gitignored. Default
  compile is `--skip-zk` (fast; enough for typecheck + simulator tests); run
  `compile:zk` only when proving keys are actually needed (real deploys).
- **Shared plumbing lives ONCE, in `packages/lib`.** The moment a second package
  needs a helper, it moves to lib and both import it. Never copy
  config/wallet/provider/logging code between packages — per-package copies are the
  core sin of the old repo.
- **Unit tests are simulator-only.** A contract package's `tests/` run entirely
  in-process via `@midnight-ntwrk/compact-runtime` — no network, no docker, no
  proof server. Anything that needs a running stack belongs in the (future)
  `packages/integration-tests`, nowhere else.
- **Tests must read at a glance — table-driven over helper-driven.** A reader must
  see a test's inputs and expected outcome in the test itself (or its table row)
  without tracing helper functions. Concretely:
  - When one function under test has many input → error/output cases, write ONE
    typed case table + `it.each`, not N copy-pasted `it` blocks.
  - Long-hand written-out tests remain the right tool where the table shape
    doesn't fit: fringe cases whose setup deviates from the table's shared
    arrange step, multi-step scenarios, or single-case testing of a method
    with little functionality. Don't force those into a table — a table with
    per-row setup switches is worse than separate tests.
  - Base fixtures are visible const literals (e.g. `VALID_PARAMS`), never factory
    functions with hidden defaults. A case's variation is an explicit spread of
    the base with the delta inline in the row — the row shows base + what changed.
  - Never wrap the function under test in a helper that defaults away its
    arguments; call it directly with every argument visible at the call site.
  - Setup harnesses (e.g. `deployInitialized()`) are acceptable magic: hide the
    *arrange* step, never the *act* or *assert*.
  - Prefer slightly verbose but self-contained over terse but indirect —
    verbosity costs lines; indirection costs comprehension.
- **The websocket response path is dead. NEVER reintroduce it.** All signature
  responses flow through the signature-responses contract and are polled. No ws
  subscription, not even "temporarily as a fallback".
- **ALWAYS type.** Every function parameter, return value, variable, and prop must
  have a precise type. Never use `unknown` (and never `any`) as a substitute for
  finding the real type — dig for it in the SDK's type definitions
  (`node_modules/<pkg>/**/*.d.ts`) or the project's own packages, and use or
  re-export that.
- **ALWAYS write JSDoc on everything exported.** Every exported function,
  const, type, interface, and interface method carries a JSDoc block stating its
  purpose, one `@param <name> - <purpose>` per parameter, `@returns` when it
  returns a value, and `@throws` when it throws. Types live in the TypeScript
  signature ONLY — never repeat them in `{braces}` in the JSDoc, they drift.
  Document non-obvious contracts (mutation, consumption, ordering invariants) in
  the description, and cross-reference related exports with `{@link Name}`.
  Internal helpers get the same treatment when their behavior isn't obvious from
  the signature.
- **ALWAYS use an `enum` for a fixed set of named constants.** Status/state
  machines, kinds, modes, variants — model them as a named TypeScript `enum`, never
  a bare union of string literals or repeated inline literals. Reference members
  (`Status.Ready`), never the literal.
- **NEVER duplicate an enum (or const-enum-like object) an SDK already exports.**
  Import and use the SDK's own. Only define an app-local enum when the SDK
  genuinely has none — check its `.d.ts` first.

# Contract packages (`packages/*-contract`)

The two contract packages are deliberately identical in shape; these rules apply to
both (and to any future contract package):

- **Compile before you check.** `npm run compile` regenerates `src/managed/`;
  typecheck and tests read its emitted `contract/index.d.ts`.
- **`src/index.ts` is the curated export surface** — it re-exports the managed
  output plus the handwritten witnesses. Consumers import the package root; NEVER
  deep-import `src/managed/...` paths from outside the package (the `./managed/*`
  export exists only so runtimes can fetch `zkir/`/`keys/` as assets).
- **Witnesses live beside the contract they serve**, in `src/witnesses.ts`, typed
  against the generated `Witnesses<PS>` type.
- **Simulator test pattern** (see `tests/contract.test.ts`):
  `new Contract(witnesses)` → `contract.initialState(createConstructorContext(ps, CPK))`
  → `createCircuitContext(sampleContractAddress(), CPK, state, ps)` → call circuits,
  threading `result.context` forward → decode with `ledger(ctx.currentQueryContext.state)`.
  Pure circuits are called directly via `pureCircuits.<name>(...)`.
- **Contract-specific deploy steps stay in this package's `deploy.ts`** (managed
  path, tag, post-deploy initialise circuit call) — never in `packages/deploy`,
  which must stay generic.
