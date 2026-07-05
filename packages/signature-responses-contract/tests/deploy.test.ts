// Deploy-tx build test: runs the (argless) Compact constructor against the
// REAL compiled output and wraps the resulting state in an unproven deploy
// transaction. No network, no wallet, no proof server — but attaching
// verifier keys needs `npm run compile:zk` output, so with the default
// --skip-zk output the suite skips (visibly, via the describe title).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildDeployTransaction, makeCompiledContract } from "@midnight-erc20-vault/lib";

import {
  Contract,
  createResponsesPrivateState,
  witnesses,
  type ResponsesPrivateState,
} from "../src/index.ts";

const MANAGED_DIR = fileURLToPath(new URL("../src/managed", import.meta.url));
const HAS_VERIFIER_KEYS = existsSync(join(MANAGED_DIR, "keys"));

// Dummy coin public key (32-byte hex) for the constructor context.
const CPK = "0".repeat(64);

describe.skipIf(!HAS_VERIFIER_KEYS)(
  "signature-responses deploy tx (SKIPPED without src/managed/keys — run `npm run compile:zk -w @midnight-erc20-vault/signature-responses-contract`)",
  () => {
    it("builds an unproven deploy transaction from the real managed output", async () => {
      const compiledContract = makeCompiledContract<Contract<ResponsesPrivateState>, ResponsesPrivateState>(
        "signature-responses",
        Contract,
        witnesses,
        MANAGED_DIR,
      );

      const deployTransaction = await buildDeployTransaction(
        compiledContract,
        "undeployed",
        CPK,
        // No witness runs at deploy (argless constructor); any private state does.
        createResponsesPrivateState(new Uint8Array(32)),
      );

      expect(deployTransaction.contractAddress).not.toHaveLength(0);
      expect(deployTransaction.serializedTransaction).toBeInstanceOf(Uint8Array);
      expect(deployTransaction.serializedTransaction.length).toBeGreaterThan(0);
    });
  },
);
