// Curated export surface — this IS the "sdk" face of the package.
// Everything the compiler emitted, the handwritten witnesses, and the
// platform-agnostic contract surface (ids + provider TYPE). Environment
// bindings (zk-config source, state store, wallet adapter) deliberately
// live with each consumer, not here.

export * from "./managed/contract/index.js";
export * from "./witnesses.ts";
export * from "./contract-surface.ts";
