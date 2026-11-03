// Responder deploy entrypoint (`yarn deploy:signet-responder`): thin shell
// over the exported flow in src/deploy-signet-responder.ts so other packages
// (integration tests) can run the same deploy in-process.

import { deploySignetResponder } from "./src/deploy-signet-responder.ts";

await deploySignetResponder();
