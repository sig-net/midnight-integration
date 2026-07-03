# @midnight-erc20-vault/deploy

Generic Midnight deployer: point it at a contract package's `managed/` dir and
it builds the deploy transaction. Generalisable because our contracts
initialise via a post-deploy circuit call, not constructor args.

## Pattern (midday `buildDeployTransaction`)

Port from `BRBussy/midday`:

- `app/ui/lib/actions/buildDeployTransaction.ts` — the core flow:
  `ContractExecutable.make(compiledContract).initialize({})` (runs the Compact
  constructor and attaches verifier keys, via Effect layers
  `ZKFileConfiguration.layer(managedDir)` + `NodeContext.layer` +
  `Configuration.Keys`) → `ledger.ContractState.deserialize(...)` →
  `new ledger.ContractDeploy(state)` (the deterministic contract address is
  known here, pre-submit) → `Intent.new(ttl).addDeploy(deploy)` →
  `Transaction.fromPartsRandomized(...)` → serialize.
- `app/ui/lib/contract/loadCompiledContract.ts` — loads the generated
  `contract/` module from a managed dir; discovers witnesses generically from
  `compiler/contract-info.json` (deploy-time witnesses are throwing stubs —
  witness bodies only run inside circuits); NOTE its trick of copying the
  generated module into the app's own `node_modules` so the compact-runtime
  WASM resolves to a single instance.
- `app/ui/lib/wallet/SeedWallet.ts` — the submit half: the wallet
  `balanceUnprovenTransaction` → `signRecipe` → `finalizeRecipe` (proving) →
  `submitTransaction`.

## Our extension over midday

Our contracts take no constructor args; instead each contract package's thin
`deploy.ts` entrypoint runs its initialise circuit as a normal circuit call
after the deploy tx lands. That call path also lives here, parameterised the
same way (managed dir + circuit name + args).
