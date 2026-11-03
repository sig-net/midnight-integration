// Records a deployed contract's address in this package's published
// per-network tables (`yarn record-contract-address --contract <name>
// --network <id> --address <hex>`, run by tsx). The deploy workflow calls it
// on a checkout of main and opens a PR with the one-line diff, so the address
// reaches npm consumers only after a human reviews it. The rewrite is recordContractAddress in
// src/record-contract-address.ts, which throws rather than guess, so this
// shell writes the file only after a successful rewrite and a bad run never
// touches it.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  parseDeployedNetwork,
  parsePublishedContract,
  recordContractAddress,
} from "./src/record-contract-address.ts";
import { contractAddressFromHex } from "./src/signet-requests.ts";

const { values } = parseArgs({
  options: {
    contract: { type: "string" },
    network: { type: "string" },
    address: { type: "string" },
  },
});
if (values.contract === undefined || values.network === undefined || values.address === undefined) {
  throw new Error("usage: --contract <name> --network <id> --address <64-hex>");
}
const contract = parsePublishedContract(values.contract);
const network = parseDeployedNetwork(values.network);
const address = contractAddressFromHex(values.address);

const constantsPath = fileURLToPath(new URL("src/constants.ts", import.meta.url));
const recorded = recordContractAddress(
  readFileSync(constantsPath, "utf8"),
  contract,
  network,
  address,
);
writeFileSync(constantsPath, recorded.source);

console.log(`recorded the ${network} ${contract} address in ${constantsPath}`);
console.log(`  ${recorded.previousEntry} -> ${recorded.entry}`);
