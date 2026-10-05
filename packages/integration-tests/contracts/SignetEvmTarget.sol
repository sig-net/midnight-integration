// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title SignetEvmTarget
/// @notice EVM target paired with the request and verification circuits in
///   test-caller-contract.compact by signet-caller-evm-e2e.test.ts.
contract SignetEvmTarget {
    function isEven(uint256 value) external pure returns (bool success) {
        return value % 2 == 0;
    }

    function checkAndDouble(
        uint256 value
    ) external pure returns (bool success, uint256 amount) {
        return (value != 0, value * 2);
    }

    function revertIf(bool shouldRevert) external pure returns (bool success) {
        require(!shouldRevert, "SignetEvmTarget: reverted on request");
        return true;
    }
}
