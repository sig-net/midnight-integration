import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const [compactFile] = fs.readdirSync(__dirname).filter(f => f.endsWith(".compact"));

if (!compactFile) throw new Error("No .compact file found in current directory");

const contractBaseName = path.basename(compactFile, ".compact"); 
const contractNameCapitalized = contractBaseName[0].toUpperCase() + contractBaseName.slice(1);

const contractPath = `./managed/${contractBaseName}/contract/index.js`;
const contractModule = await import(contractPath);

// Shared, app-neutral Schnorr challenge — one compiled copy of the `schnorr`
// module, used by the off-chain signer so it never depends on any specific
// application contract.
const schnorrLibModule = await import("./managed/schnorr-lib/contract/index.js");

export * from "./witnesses";

export const contracts = {
  [contractNameCapitalized]: contractModule
};

export const schnorrChallenge = (
  annX: bigint, annY: bigint, pkX: bigint, pkY: bigint, msg: bigint[],
): bigint => schnorrLibModule.pureCircuits.schnorrChallenge(annX, annY, pkX, pkY, msg);
