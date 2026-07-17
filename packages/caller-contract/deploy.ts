// Deploy entrypoint (`yarn deploy`): thin shell over the exported flow in
// src/deploy-caller.ts so other packages (integration tests) can run the same
// deploy in-process.

import { deployCaller } from "./src/deploy-caller.ts";

await deployCaller();
