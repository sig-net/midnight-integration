// Hardhat config for compiling contracts/SignetEvmTarget.sol (this package's
// `compile:evm` script). Hardhat is the Solidity COMPILER only: the local EVM
// node itself is the `evm` docker compose service (anvil), chain id 31337 on
// port 8545 with the universal pre-funded dev accounts, exactly what the
// setup pipeline's local-chain gate, target deploy, and derived-sender
// funding key on.
import { defineConfig } from "hardhat/config";

export default defineConfig({
  solidity: {
    version: "0.8.34",
  },
});
