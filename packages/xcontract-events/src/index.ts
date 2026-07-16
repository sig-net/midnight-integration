// Curated export surface for the spike. Two independently compiled contracts —
// the callee (token) that emits a custom event, and the caller (vault) that
// invokes it cross-contract — plus their witnesses, providers, and deploy flows.

export * as Token from "./managed/Token/contract/index.js";
export * as Vault from "./managed/vault/contract/index.js";

export * from "./witnesses.ts";
export * from "./providers.ts";
export * from "./deploy.ts";
