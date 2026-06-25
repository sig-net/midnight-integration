// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestUSDC — a standard-compliant ERC20 stand-in for USDC in the local-EVM tests.
/// @notice 6 decimals (like USDC) with an open `mint` so the harness can fund the vault's
///         and users' MPC-derived EVM addresses. The vault flow only uses
///         `transfer(address,uint256)` and its bool return, for which this is behaviorally
///         identical to real USDC (returns true on success, reverts on insufficient balance).
contract TestUSDC is ERC20 {
    constructor() public ERC20("Test USD Coin", "USDC") {
        _setupDecimals(6);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
