// Responder deploy entrypoint (`yarn deploy:signet-responder`): thin shell
// over the exported flow in src/deploy-signet-responder.ts so other packages
// (integration tests) can run the same deploy in-process. With
// DEPLOY_ESTIMATE_ONLY=1 it prices the deploy and submits nothing.

import { isDeployEstimateOnly } from "./src/deploy-protocol-contract.ts";
import {
  deploySignetResponder,
  estimateSignetResponderDeploy,
} from "./src/deploy-signet-responder.ts";

await (isDeployEstimateOnly(process.env)
  ? estimateSignetResponderDeploy()
  : deploySignetResponder());
