// Thin deploy entrypoint (`npm run deploy`): points the generic deployer at
// this package's managed/ output. The real vault additionally runs
// initialize() as a normal circuit call once the deploy tx lands — that
// arrives with the port of @midnight-erc20-vault/deploy.

import { fileURLToPath } from "node:url";

import { buildDeployTransaction } from "@midnight-erc20-vault/deploy";

const result = await buildDeployTransaction({
  managedDirPath: fileURLToPath(new URL("./src/managed", import.meta.url)),
  tag: "erc20-vault",
  networkId: process.env.MIDNIGHT_NETWORK ?? "standalone",
  coinPublicKeyHex: process.env.MIDNIGHT_WALLET_COIN_PUBLIC_KEY ?? "",
});

console.log(`deployed at ${result.contractAddress}`);
