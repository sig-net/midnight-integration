# packages/cli — member rules

Read the root `/AGENTS.md` first; everything there applies. Local rules:

- This package is the **example client** of the vault: the reference
  orchestration a UI or any program would implement. Integration tests drive
  the vault THROUGH this package's exported command functions — orchestration
  logic lives here, never in tests.
- Every command is ONE exported async function in `src/commands/`, taking
  `(context, options)`. `src/main.ts` is a thin commander shell over them — no
  logic in the shell. `src/index.ts` is the import surface and must never
  execute anything on import.
- Config is read ONCE in `src/config.ts`, composing lib's
  `getMidnightNodeConfig` with the CLI-specific env. No other file in this
  package reads `process.env`.
- Connected resources (providers, wallet, the joined vault handle) come from
  the `CliContext` built in `src/context.ts` — lazily, so parsing/validation
  never touches the network. Commands never construct providers, wallets, or
  contract handles themselves; circuit calls go through the joined handle's
  `callTx.<circuit>(...)` (midnight-js), never hand-assembled transactions.
- All MPC hand-offs are POLLED from the signature-responses contract. No
  websockets, no push channels.
- Unit tests here are pure (config parsing and the like); anything needing a
  running stack belongs in `packages/integration-tests`.
- Stubbed commands throw `NotImplementedError` with a message naming the
  missing piece — never a silent no-op.
