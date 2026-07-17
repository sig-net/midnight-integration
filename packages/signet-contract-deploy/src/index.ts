// Deploy tooling for the central signet contract, self-contained for npm:
// the operator deploy flow, the Node binding of @sig-net/midnight-contract
// to its compiled assets, and the generic Midnight deploy/wallet plumbing
// (config, seed parsing, key derivation, wallet facade, unproven-tx
// build/submit) the flow is built from. The plumbing is generic on purpose —
// any contract package's deploy script composes it.

export * from "./deploy-signet-contract.ts";
export * from "./signet-contract-binding.ts";
export * from "./plumbing/network-id.ts";
export * from "./plumbing/midnight-node-config.ts";
export * from "./plumbing/seed.ts";
export * from "./plumbing/wallet.ts";
export * from "./plumbing/deploy.ts";
export * from "./plumbing/funding.ts";
