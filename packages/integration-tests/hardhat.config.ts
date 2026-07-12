// Hardhat config for the local-EVM test harness: compiles
// contracts/TestUSDC.sol and serves the long-running local JSON-RPC node
// (`npm run evm-node:integration-tests` at the repo root). The default
// edr-simulated network is chainId 31337 on port 8545 with the well-known
// pre-funded dev accounts — exactly what the setup pipeline's local-chain
// detection, token deploy, and auto-funding key on.
import { defineConfig } from "hardhat/config";

export default defineConfig({
  solidity: {
    version: "0.8.34",
  },
});
