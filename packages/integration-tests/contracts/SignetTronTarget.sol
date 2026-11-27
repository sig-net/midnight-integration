// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract SignetTronTarget {
    function isEven(uint256 value) external pure returns (bool success) {
        return value % 2 == 0;
    }

    function revertIf(bool shouldRevert) external pure returns (bool success) {
        require(!shouldRevert, "SignetTronTarget: reverted on request");
        return true;
    }
}
