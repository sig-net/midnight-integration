# @midnight-erc20-vault/signet-midnight

THE point of the repo: the Midnight-side sig-net integration. Midnight is not
yet a signet.js chain — this package is the seed of that future adapter.

Where signet.js already covers something (e.g. EVM tx preparation, address
derivation), import it rather than re-implement. Only what is Midnight-specific
belongs here.

Planned modules (ported from the old repo's `boilerplate/contract-cli/src/signet/`):

- `request-id.ts` — signet request-id computation
- `calldata-builder.ts` — EVM calldata construction
- `tx-builder.ts` — EIP-1559 transaction building
- `codec.ts` — byte/hex codecs
- `constants.ts`
- `schnorr.ts` — Jubjub response verification (Midnight-specific, not in signet.js)
- `state-reader.ts` — read pending requests/responses from the Midnight indexer
- `signet-request-response-reader.ts` — read/poll the signet contract for results
  (replaces the old websocket subscription — purged, no fallback)
