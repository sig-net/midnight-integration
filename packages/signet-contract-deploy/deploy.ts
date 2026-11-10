// Signet-contract deploy entrypoint (`yarn deploy`, root
// `yarn deploy:signet-contract`): thin shell over the exported flow in
// src/deploy-signet-contract.ts so other packages (integration tests) can
// run the same deploy in-process.

import { deploySignetContract } from "./src/deploy-signet-contract.ts";

await deploySignetContract();
