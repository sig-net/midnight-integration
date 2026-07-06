// Deploy entrypoint (`npm run deploy`): thin shell over the exported flow in
// src/deploy-signature-responses.ts so other packages (integration tests) can
// run the same deploy in-process.

import { deploySignatureResponses } from "./src/deploy-signature-responses.ts";

await deploySignatureResponses();
