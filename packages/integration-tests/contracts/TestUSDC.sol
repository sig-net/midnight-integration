// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestUSDC — a standard-compliant ERC20 stand-in for USDC on the local EVM.
/// @notice 6 decimals (like USDC) with an open `mint` so the integration-test
///         setup can fund the MPC-derived accounts. The vault flow only calls
///         `transfer(address,uint256)` and reads its bool return, for which
///         this token is behaviorally identical to USDC.
contract TestUSDC is ERC20 {
    constructor() ERC20("Test USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
