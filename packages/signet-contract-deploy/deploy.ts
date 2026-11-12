// Signet-signer deploy entrypoint (`yarn deploy`, root
// `yarn deploy:signet-signer`): thin shell over the exported flow in
// src/deploy-signet-signer.ts so other packages (integration tests) can
// run the same deploy in-process. With DEPLOY_ESTIMATE_ONLY=1 it prices the
// deploy and submits nothing.

import { isDeployEstimateOnly } from "./src/deploy-protocol-contract.ts";
import { deploySignetSigner, estimateSignetSignerDeploy } from "./src/deploy-signet-signer.ts";

await (isDeployEstimateOnly(process.env) ? estimateSignetSignerDeploy() : deploySignetSigner());
