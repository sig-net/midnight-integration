// Thin deploy entrypoint (`npm run deploy`): points the generic deployer at
// this package's managed/ output. Contract-specific post-deploy steps stay
// here, next to the contract.

import { fileURLToPath } from "node:url";

import { buildDeployTransaction } from "@midnight-erc20-vault/deploy";

const result = await buildDeployTransaction({
  managedDirPath: fileURLToPath(new URL("./src/managed", import.meta.url)),
  tag: "signature-responses",
  networkId: process.env.MIDNIGHT_NETWORK ?? "standalone",
  coinPublicKeyHex: process.env.MIDNIGHT_WALLET_COIN_PUBLIC_KEY ?? "",
});

console.log(`deployed at ${result.contractAddress}`);
