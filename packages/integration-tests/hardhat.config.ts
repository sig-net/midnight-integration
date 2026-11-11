// Hardhat config for compiling contracts/SignetEvmTarget.sol and
// contracts/SignetTronTarget.sol (this package's `compile:evm` script).
// Hardhat is the Solidity COMPILER only: the local EVM node itself is the
// `evm` docker compose service (anvil), chain id 31337 on port 8545 with the
// universal pre-funded dev accounts, exactly what the setup pipeline's
// local-chain gate, target deploy, and derived-sender funding key on. The
// local Tron node is the `tron` docker compose service (TRE), which runs
// SignetTronTarget's EVM bytecode in the TVM.
import { defineConfig } from "hardhat/config";

export default defineConfig({
  solidity: {
    compilers: [{ version: "0.8.34" }],
    overrides: {
      // The TVM implements the EVM opcode set up to the Paris fork, so the
      // Tron target is compiled for that target and never emits a later
      // opcode (PUSH0, MCOPY) the TVM may refuse.
      "contracts/SignetTronTarget.sol": {
        version: "0.8.34",
        settings: { evmVersion: "paris" },
      },
    },
  },
});
