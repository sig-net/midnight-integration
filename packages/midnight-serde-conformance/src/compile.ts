import { join } from "node:path";

import { compileFixture, CONFORMANCE_ROOT } from "./toolchain.ts";

compileFixture(join(CONFORMANCE_ROOT, "serde-fixtures.compact"), join(CONFORMANCE_ROOT, "managed"));
