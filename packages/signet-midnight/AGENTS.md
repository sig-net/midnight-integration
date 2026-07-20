# `@sig-net/midnight` — agent notes

Workspace-wide rules live in the repo-root [`/AGENTS.md`](../../AGENTS.md) and apply
here too. Member-specific rules:

- **signet.js first.** Before writing ANYTHING here, check whether signet.js
  already covers it (EVM transaction preparation, address derivation, request-id
  computation, …). If it does, import it — never re-implement. What legitimately
  remains (secp256k1 ECDSA attestation verification, Midnight indexer state
  reading, the response poller) is Midnight-specific and is the candidate list for upstreaming
  a signet.js Midnight adapter, so keep the API surface signet.js-shaped.
- **This package is chain plumbing, not app logic.** Nothing client-specific:
  it must serve any Midnight×sig-net client contract, not one application.
  Client-specific glue belongs in that client's contract package (in this
  repo: caller-contract) or its integration tests.
- **Responses are polled from the signet contract** via
  `response-poller.ts` / `state-reader.ts`. The old websocket subscription is
  purged repo-wide — do not reintroduce it here of all places.
- **Port source:** the old repo's `boilerplate/contract-cli/src/signet/`
  (request-id, calldata-builder, tx-builder, codec, constants, ecdsa,
  state-reader). Audit each module against signet.js during the port; only what
  signet.js lacks comes across.
