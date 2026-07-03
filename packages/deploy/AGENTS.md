# `@midnight-erc20-vault/deploy` — agent notes

Workspace-wide rules live in the repo-root [`/AGENTS.md`](../../AGENTS.md) and apply
here too. Member-specific rules:

- **NEVER put contract-specific code in this package.** The generic deployer's
  entire per-contract input surface is: managed-dir path, tag, network id, coin
  public key (see `DeployParams`). If an implementation "needs to know" which
  contract it is deploying — an initialise argument, a witness body, a managed
  filename — that logic belongs in the contract package's own `deploy.ts`, passed
  in as data. Witness discovery is generic: read the declared witness names from
  `compiler/contract-info.json` and install throwing stubs (legitimate — witness
  bodies only execute inside circuits at proving time, never in the constructor).
- **Single WASM runtime instance.** When loading a generated `contract/index.js`
  module, resolve `@midnight-ntwrk/compact-runtime` to ONE instance (midday copies
  the generated module into its own `node_modules` cache before importing — see
  `BRBussy/midday app/ui/lib/contract/loadCompiledContract.ts`). Two instances of
  the WASM runtime produce "expected instance of…" errors at a distance.
- **The port source is midday, not the old repo.** Build on
  `app/ui/lib/actions/buildDeployTransaction.ts` (build the unproven
  `ContractDeploy` tx via `ContractExecutable.make(...).initialize({})` +
  `ledger-v8` `Intent`/`Transaction`) and `lib/wallet/SeedWallet.ts` (the
  balance → sign → prove → submit half). Do NOT port the old repo's
  `midnight-js-contracts`-era deploy code — it is the previous-generation stack.
- **Our one extension over midday:** these contracts initialise via a post-deploy
  circuit call, not constructor args. That call path lives here too, parameterised
  the same generic way (managed dir + circuit name + args); the *choice* of circuit
  and args comes from the calling contract package.
