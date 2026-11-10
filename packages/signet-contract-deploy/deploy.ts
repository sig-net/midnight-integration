// Signet-signer deploy entrypoint (`yarn deploy`, root
// `yarn deploy:signet-signer`): thin shell over the exported flow in
// src/deploy-signet-signer.ts so other packages (integration tests) can
// run the same deploy in-process.

import { deploySignetSigner } from "./src/deploy-signet-signer.ts";

await deploySignetSigner();
