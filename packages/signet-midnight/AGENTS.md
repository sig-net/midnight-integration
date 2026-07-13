# `@sig-net/midnight` — agent notes

Workspace-wide rules live in the repo-root [`/AGENTS.md`](../../AGENTS.md) and apply
here too. Member-specific rules:

- **signet.js first.** Before writing ANYTHING here, check whether signet.js
  already covers it (EVM transaction preparation, address derivation, request-id
  computation, …). If it does, import it — never re-implement. What legitimately
  remains (Jubjub Schnorr verification, Midnight indexer state reading, the
  response poller) is Midnight-specific and is the candidate list for upstreaming
  a signet.js Midnight adapter, so keep the API surface signet.js-shaped.
- **This package is chain plumbing, not app logic.** Nothing vault-specific: it
  must serve any future Midnight×sig-net example, not just the ERC20 vault.
  Vault-specific glue belongs in the vault-contract package or the (future)
  integration tests.
- **Responses are polled from the signet contract** via
  `response-poller.ts` / `state-reader.ts`. The old websocket subscription is
  purged repo-wide — do not reintroduce it here of all places.
- **Port source:** the old repo's `boilerplate/contract-cli/src/signet/`
  (request-id, calldata-builder, tx-builder, codec, constants, schnorr,
  state-reader). Audit each module against signet.js during the port; only what
  signet.js lacks comes across.
