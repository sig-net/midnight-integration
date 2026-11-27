# Decisions

Rationale behind choices in this repository that the code alone cannot show.

## Wallet sync batch size is 1000

`SYNC_BATCH_SIZE` in `packages/signet-contract-deploy/src/plumbing/wallet.ts`
sets how many indexer events the shielded and DUST wallets apply per batch.
The wallet SDK defaults to 10, where per-batch overhead dominates a sync.
A full DUST sync measured:

| batch size | full DUST sync |
| ---------- | -------------- |
| 10         | 209 s          |
| 100        | 80 s           |
| 1000       | 72 s           |

At 1000 one core is saturated, so a larger batch buys nothing further.
