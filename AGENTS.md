# midnight-erc20-vault — workspace-wide agent rules

This repository is a single **Yarn workspace** (Yarn 4 via corepack, `nodeLinker:
node-modules`). Its members live under `packages/`:

- **`packages/lib`** — shared runtime plumbing (config, network, providers, wallet,
  logging). The ONLY copy of these files.
- **`packages/signet-midnight`** — the Midnight-side sig-net integration; the point
  of the repo, and the basis for a signet.js Midnight adapter.
- **`packages/vault-contract`** / **`packages/signet-contract`** — one
  package per Compact contract, no contract/sdk split. See "Contract packages" below.

Run `yarn install` from the repo root — never from inside a member.
Run `yarn compile` once before `build`/`test`: the contract packages AND
`packages/signet-midnight` typecheck against their generated `src/managed/`
output (signet-midnight compiles its Compact module's pure circuits via
`src/circuits.compact` — skip-zk only, no `compile:zk` script on purpose).

Member-specific rules live in that member's own `AGENTS.md`.

# Running the integration e2e suite

The operational runbook for `yarn test:integration-tests` lives in
[`.claude/skills/e2e/SKILL.md`](.claude/skills/e2e/SKILL.md) — read it BEFORE
running or re-deploying the e2e stack. It covers what the test pipeline docs
(`packages/integration-tests/README.md`) do not: clean redeploys, why the
derived EVM accounts move with the vault contract address (and the fund-sweep
script for recovering their Sepolia balances), the fakenet MPC responder
hand-off, and pacing (zk keygen runs ~10 minutes — background the run).
It is packaged as a Claude Code skill (`/e2e`), but it is plain markdown
written for ANY agent or human to follow.

# NEVER BREAK rules

These are non-negotiable. Do not violate them unless the user explicitly grants an
exception for that specific case.

- **Rules here are timeless and standalone — write them in the present tense.** This
  governs every rule in this file, including future additions. State what to do and
  why it is right *now*, never how the codebase got here. NO references to a prior
  repo, an earlier branch, a migration or port in progress, a "future" package that
  may already exist, or anything else that goes stale the moment this branch merges.
  A rule must read correctly to someone who arrives at `main` with no memory of how
  it was built. Concrete rationale and bad-vs-good examples are encouraged ("copying
  config between packages → drift"); historical narrative is not ("this was tried and
  dropped", "the sin of the old repo"). Keep the lesson, drop the story.
- **NEVER carry dead code.** Unused env vars, disabled or unreachable code paths,
  scaffold leftovers, commented-out blocks — delete them, never leave them for
  "later". Code that isn't reached is a lie about what the system does.
- **ALWAYS install dependencies at the latest STABLE version; NEVER pin.** First
  resolve the version — `yarn npm info <pkg> --fields dist-tags,version,deprecated`
  — then add it explicitly: `yarn workspace <workspace> add <pkg>@^<version>`, where
  `<version>` is that latest stable release. The caret is deliberate and NOT
  optional: `yarn add` writes exactly the range you name, so a bare
  `<pkg>@<version>` would silently pin — always spell the `^`. Naming the version
  inside the caret range is NOT a pin: the range still floats; spelling it out just
  forces you to look at what you're pulling in. If the resolved latest is a
  prerelease (an `-rc`/`-beta`/`-alpha`/`-next`/`-canary` in the version string),
  STOP and ask the user — never adopt a prerelease unprompted; let them opt in.
  Before you install, confirm the release is sound: it is not deprecated (from the
  `yarn npm info` above), and after install `yarn npm audit` reports no new
  advisory. The compact toolchain
  is likewise unpinned: `compact update`
  installs it and compile scripts carry **no `+version` pin**. Corollary: a
  dependency shared by two members MUST resolve to the same version in every member
  — bump it everywhere in the same change and `yarn install` from the root. A single
  shared version is what keeps the WASM-backed `@midnight-ntwrk/*` packages
  resolving to one instance; divergence causes dual-instance "expected instance
  of…" bugs.
- **NEVER emit JavaScript.** Packages export TypeScript source
  (`"." : "./src/index.ts"`); `build` means `tsc` under the base config's `noEmit`.
  No `dist/`, no `tsc --outDir`, no ts-node loaders, no copy steps. Tests run under
  vitest; entrypoints run under `tsx`. If you think you need a build step, stop and
  ask — a build step is a defect in this workspace, not a missing feature.
- **ALWAYS finish a change with `yarn build && yarn test`** in the member you
  touched (or from the root). `tsx` and vitest execute without typechecking — "it
  runs" is NOT verification. If you add a new top-level TS directory to a member,
  add it to that member's tsconfig `include` in the same change; a file outside
  `include` passes silently and then breaks in the IDE.
- **NEVER commit generated compiler output.** Each contract package's
  `src/managed/` is produced by `yarn compile` and is gitignored. Default
  compile is `--skip-zk` (fast; enough for typecheck + simulator tests); run
  `compile:zk` only when proving keys are actually needed (real deploys).
- **Shared plumbing lives ONCE, in `packages/lib`.** The moment a second package
  needs a helper, it moves to lib and both import it. Never copy
  config/wallet/provider/logging code between packages — per-package copies drift
  apart and are a defect, not a shortcut.
- **Unit tests are simulator-only.** A contract package's `tests/` run entirely
  in-process via `@midnight-ntwrk/compact-runtime` — no network, no docker, no
  proof server. Anything that needs a running stack belongs in
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
  responses flow through the signet contract and are polled. No ws
  subscription, not even "temporarily as a fallback".
- **ALWAYS type.** Every function parameter, return value, variable, and prop must
  have a precise type. Never use `unknown` (and never `any`) as a substitute for
  finding the real type — dig for it in the SDK's type definitions
  (`node_modules/<pkg>/**/*.d.ts`) or the project's own packages, and use or
  re-export that.
- **Keep domain values in their richest type; serialize ONLY at the edges.** A
  transaction stays an ethers `Transaction`, an id stays its branded type, an
  amount stays `bigint` — pass the typed object between internal functions, and
  collapse it to a string (`.serialized`, hex, `.toString()`) only where it truly
  leaves the program: stdout/logging, a CLI arg parser, an RPC/`fetch` body, an
  on-ledger write. Re-parsing a value you already had typed (e.g.
  `Transaction.from(tx.serialized)`) is the smell this bans — it discards a
  precise type, invites drift, and can fail on data your own code just produced.
  A producer returns the typed object; the single caller that hits the edge does
  the conversion. Logging a hash mid-flow is fine — that reads a field, it
  doesn't degrade the value everything downstream uses.
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
- **NEVER write a TS function that mimics the behavior of a pure circuit that
  could be exported.** Export the circuit through the shared module's compiled
  surface (signet-midnight's `circuits.compact`) and call the compiled artifact
  (`pureCircuits.<name>`). TS may only implement what circuits cannot:
  secret-key signing, witness computations (e.g. `callerSecretKey`), and
  byte plumbing. A TS twin of provable logic WILL drift from the circuit and
  break agreement with the proofs silently.
- **Declare types and helpers immediately above their single consumer; the top
  of a file is reserved for what the WHOLE file needs.** Reading a function
  must never require scrolling back and forth between it and a definition
  somewhere else in the file: a struct/type/interface/constant/helper used by
  exactly ONE function sits directly above that function. The top of a file
  holds only file-wide declarations — module state (a contract's ledger
  layout, a package's config) and anything consumed by two or more functions.
  The moment a declaration gains a second consumer, move it to the top (or out
  to its shared home) in the same change — never leave it attached to its
  first consumer. This applies to every language in the repo: TypeScript,
  Compact contracts, test files, all of it.
- **Root scripts that target one member are named `<task>:<package-dir>` — the
  member's directory name in full, never a shorthand.** `compile:vault-contract`,
  `deploy:signet-contract`, `test:integration-tests` — never
  `compile:vault` or `deploy:responses`: abbreviations save keystrokes once and
  cost a which-package-was-that lookup forever. (A script named exactly after its
  package, like `cli`, is fine; aggregate scripts like `compile` / `build` /
  `test` take no suffix.) When adding or renaming a root script, grep the WHOLE
  repo for the old name before finishing — script names are load-bearing outside
  package.json: integration tests shell out to root scripts by name (see
  `runRootScript`), and task.md/READMEs quote them.

# Contract packages (`packages/*-contract`)

The two contract packages are deliberately identical in shape; these rules apply to
both (and to any additional contract package):

- **Compile before you check.** `yarn compile` regenerates `src/managed/`;
  typecheck and tests read its emitted `contract/index.d.ts`.
- **`src/index.ts` is the curated export surface** — it re-exports the managed
  output plus the handwritten witnesses. Consumers import the package root; NEVER
  deep-import `src/managed/...` paths from outside the package (the `./managed/*`
  export exists only so runtimes can fetch `zkir/`/`keys/` as assets).
- **Witnesses live beside the contract they serve**, in `src/witnesses.ts`, typed
  against the generated `Witnesses<PS>` type.
- **Simulator test pattern** (see `tests/contract.test.ts`):
  `new Contract(witnesses)` → `await contract.initialState(createConstructorContext(ps, CPK))`
  → `createCircuitContext(circuitId, sampleContractAddress(), CPK, state, ps)` → await
  circuits (they are async), threading `result.context` forward → decode with
  `ledger(ctx.callContext.currentQueryContext.state)`. Circuit failures reject the
  promise (`await expect(...).rejects.toThrow(...)`). Pure circuits are synchronous,
  called directly via `pureCircuits.<name>(...)`.
- **The deploy split: generic plumbing in lib, everything contract-specific in
  this package's `deploy.ts`.** `packages/lib`'s deploy/wallet helpers
  (`buildDeployTransaction`, `makeCompiledContract`, `submitUnprovenTransaction`,
  …) know no contract; the deploy script owns the constructor args, witnesses,
  private state and post-deploy circuit calls, statically importing its own
  generated module so all of it stays fully typed. There is NO generic deployer
  package: a generic deployer forces dynamic module loading and witness stubs, which
  break the moment a constructor takes real args — keep deploy logic static and
  fully typed in the contract's own package.
