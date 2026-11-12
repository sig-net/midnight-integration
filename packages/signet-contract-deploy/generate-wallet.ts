// Wallet generation entrypoint (root `yarn generate:wallet [network...]`):
// thin shell over the exported flow in src/generate-wallet.ts. It prints a
// fresh wallet's secret, so run it only where the terminal is private.

import {
  formatGeneratedWallet,
  generateWallet,
  parseWalletNetworks,
} from "./src/generate-wallet.ts";

console.log(formatGeneratedWallet(generateWallet(parseWalletNetworks(process.argv.slice(2)))));
