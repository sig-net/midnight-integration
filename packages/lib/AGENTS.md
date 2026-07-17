# `@midnight-protocol/lib` — agent notes

Workspace-wide rules live in the repo-root [`/AGENTS.md`](../../AGENTS.md) and apply
here too. Member-specific rules:

- **Admission test: a second consumer AND repo-privacy.** Code enters lib when a
  second package needs it *and* it must stay private to this repo. Generic,
  publishable deploy/wallet/config plumbing belongs in
  `@sig-net/midnight-contract-deploy`'s `src/plumbing/` instead — external
  consumers of the published packages need it too. Don't park single-consumer
  helpers here "for later" — they live with their consumer until reuse is real.
  The inverse also holds: the moment a helper is copied into a second package,
  that copy is a bug; move it to the right shared home instead.
- **Nothing contract-specific, nothing app-specific.** lib is runtime plumbing:
  today, the midnight-js provider adapters (`midnight-providers.ts`). If it
  mentions a specific contract, a circuit name, or signet semantics, it belongs
  in a contract package or signet-midnight.
- **Config is parsed once, in the deploy package.** Environment variables and
  network endpoints (indexer / node / proof server URLs) are parsed by
  `@sig-net/midnight-contract-deploy`'s `getMidnightNodeConfig` /
  `getDeployConfig` and flow to consumers as arguments. No package reads
  `process.env` for shared settings, and endpoint URLs are never hardcoded at a
  call site.
- **Keep the dependency footprint honest.** A dep added to lib is paid by every
  consumer. Heavy deps (wallet SDK, ledger WASM) are fine — that's what lib is for
  — but don't add a dep only one consumer's feature needs.
- **The proof-provider wrapper is a stopgap.** It exists to graft `lookupKey`
  onto midnight-js's proving provider — see the JSDoc in
  `src/midnight-providers.ts` for when it can be deleted.
