# midnight-protocol — workspace-wide agent rules

This repository is a single **Yarn workspace** (Yarn 4 via corepack, `nodeLinker:
node-modules`). Its members live under `packages/`:

- **`packages/lib`** — shared runtime plumbing that stays private to the repo
  (the midnight-js provider adapters). The ONLY copy of these files.
- **`packages/signet-midnight`** — the Midnight-side sig-net integration; the point
  of the repo, and the basis for a signet.js Midnight adapter.
- **`packages/signet-contract`** / **`packages/test-caller-contract`** — one
  package per Compact contract, no contract/sdk split: the central signet
  singleton, and the minimal client that exercises it generically. See
  "Contract packages" below.
- **`packages/test-caller-contract-20-field`** — a 20-field requester contract
  kept ONLY as the lockstep fixture for chunked-ledger raw parsing (past 15
  fields compactc stores ledger fields in a chunk tree; its simulator tests
  pin `@sig-net/midnight`'s field resolver against real compiler output).
  No deploy flow, no notifier, compile is skip-zk only.
- **`packages/wallet`** — the published `@sig-net/midnight-wallet`: the
  `Wallet` interface (midnight-js's WalletProvider + MidnightProvider roles
  plus addresses, balances and data signing), the in-process `LocalWallet`
  over the wallet-sdk facade (a seed goes in, a wallet comes out; key
  material and the facade stay internal), seed parsing and the
  network/endpoint config to connect one.
- **`packages/signet-contract-deploy`** — the published, self-contained deploy
  tooling: the signet-contract deploy flow plus the generic deploy plumbing
  (`src/plumbing/`: deploy config, unproven-tx build, funding primitives)
  every contract package's deploy script composes, on top of
  `@sig-net/midnight-wallet`.
- **`packages/integration-tests`** — everything that needs a running stack:
  the generic signet-caller e2e and its setup pipeline.
Example applications built on these packages (e.g. the ERC20 vault) live in
`sig-net/midnight-examples`, consuming the published `@sig-net/*` packages
from npm.

Run `yarn install` from the repo root — never from inside a member.
Run `yarn compile` once before `build`/`test`: the contract packages AND
`packages/signet-midnight` typecheck against their generated `src/managed/`
output (signet-midnight compiles its Compact module's pure circuits via
`src/circuits.compact` — skip-zk only, no `compile:zk` script on purpose).

Member-specific rules live in that member's own `AGENTS.md`.

# Running the integration e2e suite

The operational runbook for `yarn test:integration-tests` — the generic
signet-caller e2e — lives in
[`.claude/skills/e2e/SKILL.md`](.claude/skills/e2e/SKILL.md) — read it BEFORE
running or re-deploying the e2e stack. It covers what the test pipeline docs
(`packages/integration-tests/README.md`) do not: the fresh-clone path, clean
redeploys after a circuit change, the fakenet MPC responder hand-off, the
proof-server OOM playbook, and pacing (zk keygen runs ~10 minutes —
background the run). It is packaged as a Claude Code skill (`/e2e`), but it
is plain markdown written for ANY agent or human to follow.

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
- **ALWAYS install exact, frozen versions; the committed `yarn.lock` is the source
  of truth.** Dependencies do NOT float. CI runs `yarn install --immutable` (see
  `.github/workflows/*.yml`) and FAILS rather than resolve a newer version, so a
  version bump is only ever a deliberate, reviewed change. To add or change a
  dependency: resolve the version first —
  `yarn npm info <pkg> --fields dist-tags,version,deprecated` — then
  `yarn workspace <workspace> add <pkg>@^<version>` at that latest stable release,
  and COMMIT the refreshed `yarn.lock` in the SAME change. The caret range left in
  `package.json` is fine: the committed lockfile, not the range, is what pins the
  build, and `--immutable` guarantees CI installs exactly what the lockfile records.
  If the resolved latest is a prerelease (an `-rc`/`-beta`/`-alpha`/`-next`/`-canary`
  in the version string), STOP and ask the user — never adopt a prerelease
  unprompted; let them opt in. Before you install, confirm the release is sound: it
  is not deprecated (from the `yarn npm info` above), and after install
  `yarn npm audit` reports no new advisory. The compact toolchain is likewise
  PINNED, not floating: the launcher (`compact-v0.5.1`) and the compiler
  (`compactc 0.33.0-rc.2`) are fetched by EXACT URL in the CI/publish workflows,
  which set `0.33.0-rc.2` as the launcher default; the compile scripts call
  `compact compile` against that default, so locally you must pin the same default
  (`compact update 0.33.0-rc.2`) or your `managed/` output will diverge. The
  launcher tag, the compiler URL, the npm `@midnightntwrk/*` stack, and the
  workflow cache keys are a MATCHED SET — bump them together in one change. Corollary:
  a dependency shared by two members MUST resolve to the same version in every member
  — bump it everywhere in the same change and `yarn install` from the root. A single
  shared version is what keeps the WASM-backed `@midnight-ntwrk/*` packages
  resolving to one instance; divergence causes dual-instance "expected instance
  of…" bugs.
- **NEVER emit JavaScript.** Packages export TypeScript source
  (`"." : "./src/index.ts"`); `build` means `tsc` under the base config's `noEmit`.
  No `dist/`, no `tsc --outDir`, no ts-node loaders, no copy steps. Tests run under
  vitest; entrypoints run under `tsx`. If you think you need a build step, stop and
  ask — a build step is a defect in this workspace, not a missing feature.
  **The one exception is publishing:** the npm-published packages
  (`@sig-net/midnight`, `@sig-net/midnight-contract`,
  `@sig-net/midnight-contract-deploy`) additionally emit `dist/` via a
  `tsconfig.build.json`, ship ONLY `dist/` (`files: ["dist"]`), and swap their
  entry to it through `publishConfig.exports` at pack time — the monorepo itself
  still resolves their raw `src/index.ts`, never `dist/`.
- **ALWAYS finish a change with `yarn format:check && yarn lint && yarn build &&
  yarn test`** in the member you touched (or from the root). `tsx` and vitest
  execute without typechecking — "it runs" is NOT verification. If you add a new
  top-level TS directory to a member, add it to that member's tsconfig `include`
  in the same change; a file outside `include` passes silently and then breaks in
  the IDE — and `projectService` has no program for it, so type-aware lint rules
  go quiet on it too.
- **Lint and format config lives ONCE, at the repo root.** `eslint.config.js`
  (ESLint flat config, `typescript-eslint` strict + stylistic type-checked) and
  `.prettierrc.json` cover every member; NEVER add a per-package
  `eslint.config.*` or `.prettierrc*` — per-package copies drift, exactly as the
  "shared plumbing lives ONCE" rule below forbids. Scripts are root-only too:
  `yarn lint`, `yarn lint:fix`, `yarn format`, `yarn format:check` (`eslint .`
  from the root already covers every member, so there are no
  `lint:<package-dir>` variants). Type-aware rules read the generated
  `src/managed/` types, so **`yarn lint` runs AFTER `yarn compile`**, the same
  ordering `yarn build` needs — this is why CI's `unit` job runs format-check
  before compile and lint after it.
- **`eslint.config.js` turns NO rule off. Keep it that way.** The config has
  zero `"off"` entries: every finding is fixed in the code instead. The only
  non-default rule options either widen coverage (`require-jsdoc` reaching
  types, interfaces and exported consts) or teach a rule about an API it
  predates (`expect-expect` knowing vitest's `expectTypeOf`). If a rule fires,
  fix the code; adding an `"off"` needs a reason good enough to write down here
  first. An `eslint-disable` likewise carries a `--` explanation, and
  `linterOptions.reportUnusedDisableDirectives` is `error`, so a directive that
  stops applying fails the build rather than rotting. Reach for a real type
  from the SDK's `.d.ts` before reaching for a disable.
- **Two TypeScripts, on purpose: members build on 7, ESLint reads types through
  a root-only 6.0.3.** Every member pins `typescript@^7.0.2`, the native Go
  compiler `yarn build` runs and the one that emits every published `dist/`.
  TypeScript 7 ships no public compiler API (it is scheduled for 7.1), so
  typescript-eslint declares `peerDependencies.typescript: ">=4.8.4 <6.1.0"` and
  cannot parse `.ts` at all under 7 — not merely lose its type-aware rules. The
  root therefore carries `typescript@6.0.3` as a devDependency used ONLY by the
  lint toolchain, which is Microsoft's own documented transition pattern (they
  publish `@typescript/typescript6` for the same purpose). yarn resolves the
  root to 6.0.3 and nests 7.0.2 under each member, so `yarn build` keeps the
  native compiler. The published emit is unaffected: building the four `@sig-net/*`
  packages under both compilers yields byte-identical `.js` and `.d.ts` (only
  `.map` sourcemaps differ). DELETE the root pin once typescript-eslint supports
  the 7.1 API; until then, do NOT "tidy" the two versions into one, and remember
  lint's checker is a major behind the one that gates the build.
- **`noUncheckedIndexedAccess` is on.** `arr[i]` and `record[key]` are typed
  `T | undefined`, so an index read is narrowed at its use site (a guard, `.at()`,
  or iteration over the collection) rather than asserted with `!`. This is what
  makes `@typescript-eslint/no-unnecessary-condition` trustworthy: a bounds
  guard on decoded chain data reads as necessary to both the compiler and the
  linter. Prefer `for (const x of bytes.subarray(a, b))` over an index loop:
  iteration yields `T`, indexing yields `T | undefined`.
- **NEVER commit generated compiler output.** Each contract package's
  `src/managed/` is produced by `yarn compile` and is gitignored. Default
  compile is `--skip-zk` (fast; enough for typecheck + simulator tests); run
  `compile:zk` only when proving keys are actually needed (real deploys).
- **Shared plumbing lives ONCE.** Wallet, seed and network/endpoint-config
  plumbing lives in `packages/wallet` (`@sig-net/midnight-wallet`); generic
  deploy plumbing lives in `packages/signet-contract-deploy/src/plumbing/`
  (both published, so external consumers get them too); repo-private shared
  helpers (the midnight-js proof provider) live in `packages/lib`. The moment
  a second package needs a helper, it moves to the right one of those homes
  and both import it. Never copy config/wallet/provider/logging code between
  packages — per-package copies drift apart and are a defect, not a shortcut.
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
  member's directory name in full, never a shorthand.** `compile:test-caller-contract`,
  `deploy:signet-contract`, `test:integration-tests` — never
  `compile:caller` or `deploy:signet`: abbreviations save keystrokes once and
  cost a which-package-was-that lookup forever. (Aggregate scripts like
  `compile` / `build` / `test` take no suffix.) When adding or renaming a root
  script, grep the WHOLE repo for the old name before finishing — script names
  are load-bearing outside package.json: integration tests shell out to root
  scripts by name (see `runRootScript`), and workflows/READMEs quote them.

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
- **The deploy split: generic plumbing in `@sig-net/midnight-contract-deploy`
  (on top of `@sig-net/midnight-wallet`), everything contract-specific in
  this package's `deploy.ts`.** The deploy package's helpers
  (`buildDeployTransaction`, `makeCompiledContract`, `assertDeployerFunded`,
  …) and the wallet's `Wallet` interface (`balanceUnprovenTx`, `submitTx`)
  know no contract; the deploy script owns the constructor args, witnesses,
  private state and post-deploy circuit calls, statically importing its own
  generated module so all of it stays fully typed. There is NO generic deployer
  package: a generic deployer forces dynamic module loading and witness stubs, which
  break the moment a constructor takes real args — keep deploy logic static and
  fully typed in the contract's own package.
