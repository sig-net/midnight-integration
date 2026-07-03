// Shared runtime plumbing — the ONLY copy. Modules arriving with the port
// (from the old repo's boilerplate/contract-cli/src/):
//
//   config.ts     network configs (standalone / testnet-local / testnet-remote:
//                 indexer, node, proof-server URLs)        <- config.ts
//   network.ts    network id selection helpers             <- config.ts
//   providers.ts  configureProviders and friends           <- api.ts
//   wallet.ts     buildWallet / waitForFunds / fund helpers <- api.ts
//   logging.ts    pino-based createLogger                  <- logger-utils.ts

export {};
