/**
 * Hardhat config for the vault's local-EVM integration harness.
 *
 * Compiles a standard-compliant ERC20 (TestUSDC, 6 decimals via OpenZeppelin 3.4.2) and
 * exposes a local node (chainId 31337) that the MPC simulator broadcasts signed EIP-1559
 * transactions to. solc 0.6.12 matches the OZ 3.4.2 contracts.
 *
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    version: '0.6.12',
    settings: {
      optimizer: { enabled: true, runs: 10000 },
    },
  },
  networks: {
    hardhat: { chainId: 31337 },
  },
};
