// Deploy entrypoint (`yarn deploy`): thin shell over the exported flow in
// src/deploy-vault.ts so other packages (integration tests) can run the same
// deploy in-process.

import { deployVault } from "./src/deploy-vault.ts";

await deployVault();
