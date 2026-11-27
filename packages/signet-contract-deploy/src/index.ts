// Deploy tooling for the signet contracts, self-contained for npm: the
// operator deploy flows of the signet signer and the signet responder,
// the Node bindings of @sig-net/midnight-signer and
// @sig-net/midnight-responder to their compiled assets, and the generic
// Midnight deploy/wallet plumbing (config, seed parsing, key derivation,
// wallet facade, unproven-tx build/submit) the flows are built from. The
// plumbing is generic on purpose — any contract package's deploy script
// composes it.

export * from "./deploy-protocol-contract.ts";
export * from "./deploy-signet-responder.ts";
export * from "./deploy-signet-signer.ts";
export * from "./generate-wallet.ts";
export * from "./plumbing/counterparties.ts";
export * from "./plumbing/deploy.ts";
export * from "./plumbing/dust-generation.ts";
export * from "./plumbing/env.ts";
export * from "./plumbing/format-amounts.ts";
export * from "./plumbing/funding.ts";
export * from "./plumbing/midnight-node-config.ts";
export * from "./plumbing/network-id.ts";
export * from "./plumbing/seed.ts";
export * from "./plumbing/wallet.ts";
export * from "./plumbing/wallet-cache.ts";
export * from "./signet-responder-binding.ts";
export * from "./signet-signer-binding.ts";
