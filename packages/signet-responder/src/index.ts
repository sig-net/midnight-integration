// Curated export surface: everything the compiler emitted, the handwritten
// witnesses, and the platform-agnostic contract surface (ids + provider TYPE).
// Environment bindings (zk-config source, state store, wallet adapter) live
// with each consumer, not here.

export * from "./contract-surface.ts";
export * from "./managed/contract/index.js";
export * from "./witnesses.ts";
