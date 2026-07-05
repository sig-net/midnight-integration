# `@midnight-erc20-vault/lib` — agent notes

Workspace-wide rules live in the repo-root [`/AGENTS.md`](../../AGENTS.md) and apply
here too. Member-specific rules:

- **Admission test: a second consumer.** Code enters lib when (and only when) a
  second package needs it. Don't park single-consumer helpers here "for later" —
  they live with their consumer until reuse is real. The inverse also holds: the
  moment a helper is copied into a second package, that copy is a bug; move it
  here instead.
- **Nothing contract-specific, nothing app-specific.** lib is runtime plumbing:
  config, network selection, providers, wallet building, logging. If it mentions
  the vault, a circuit name, or signet semantics, it belongs in a contract package
  or signet-midnight.
- **Config is read here and only here.** Environment variables and network
  endpoints (indexer / node / proof server URLs) are parsed once in lib's config
  module and flow to consumers as arguments. No other package reads `process.env`
  for shared settings, and endpoint URLs are never hardcoded at a call site.
- **Keep the dependency footprint honest.** A dep added to lib is paid by every
  consumer. Heavy deps (wallet SDK, ledger WASM) are fine — that's what lib is for
  — but don't add a dep only one consumer's feature needs.
- **Deploy plumbing is generic here, contract-specific in the contract
  packages.** `deploy.ts` (deploy config, compiled-contract binding, building
  the unproven deploy tx) and the submit half of `wallet.ts`
  (`submitUnprovenTransaction`, `withSyncedWalletFacade`) serve every contract
  package's own `deploy.ts` script. Constructor args, witnesses and private
  state flow in through type parameters — a circuit or contract name appearing
  in lib is a bug. (An exception to the env-var rule above: a contract-specific
  secret like `VAULT_DEPLOYER_SECRET_KEY` is read by that contract's deploy
  script, not here — it is not a shared setting.)
- **Port source:** the old repo's `boilerplate/contract-cli/src/` — `config.ts`
  (network configs), `api.ts` (wallet + providers; split it into `providers.ts` /
  `wallet.ts` on the way in), `logger-utils.ts` (pino logging). The deploy-tx
  build and unproven-tx submission are ported from midday
  `app/ui/lib/actions/buildDeployTransaction.ts` and `lib/wallet/SeedWallet.ts`
  (NOT the old repo's `midnight-js-contracts` stack).
