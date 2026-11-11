// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title SignetTronTarget
/// @notice Tron target paired with the Tron request and verification
///   circuits in test-caller-contract.compact by
///   signet-caller-tron-e2e.test.ts. The MPC attests a Tron call's outcome
///   only (executed or failed), never its return data, so each method
///   exists for the outcome it produces.
contract SignetTronTarget {
    function isEven(uint256 value) external pure returns (bool success) {
        return value % 2 == 0;
    }

    function revertIf(bool shouldRevert) external pure returns (bool success) {
        require(!shouldRevert, "SignetTronTarget: reverted on request");
        return true;
    }
}
