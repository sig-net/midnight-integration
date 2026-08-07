// Deploy tooling for the central signet contract, self-contained for npm:
// the operator deploy flow, the Node binding of @sig-net/midnight-contract
// to its compiled assets, and the generic contract-deploy plumbing (deploy
// config, unproven-tx build, funding primitives) any contract package's
// deploy script composes. The wallet itself — interface, implementations,
// seed/key/config plumbing — comes from @sig-net/midnight-wallet, re-exported
// here so a deploy script needs only this package.

export * from "./deploy-signet-contract.ts";
export * from "./plumbing/deploy.ts";
export * from "./plumbing/funding.ts";
export * from "./signet-contract-binding.ts";
export * from "@sig-net/midnight-wallet";
