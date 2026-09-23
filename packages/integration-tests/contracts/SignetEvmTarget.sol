// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title SignetEvmTarget
/// @notice The growing ABI-complexity target for the signet EVM e2e
///   (tests/signet-caller-evm-e2e.test.ts). Each method pairs with one
///   submit/verify circuit pair in test-caller-contract.compact and one
///   ordered test stage; new methods of higher ABI complexity are added the
///   same way over time (bytesN, address, string, arrays, multi-word
///   calldata).
/// @dev Every method MUST be pure: outputs derived only from the call's
///   arguments and constants. The fakenet re-simulates the mined call via
///   eth_call against the PREVIOUS block's state, so any dependence on
///   storage or block context could make the attested output diverge from
///   the mined execution. A second rule for future methods: attested uint256
///   outputs must stay below the BLS scalar field modulus (uint256 maps to a
///   Compact Field, and serializeRespondOutput range-checks it).
contract SignetEvmTarget {
    /// Stage 1a: single-bool respond schema (packed respond width 1 byte).
    function isEven(uint256 value) external pure returns (bool success) {
        return value % 2 == 0;
    }

    /// Stage 1b: multi-field respond schema, bool + uint256 (packed respond
    /// width 1 + 32 = 33 bytes).
    function checkAndDouble(
        uint256 value
    ) external pure returns (bool success, uint256 amount) {
        return (value != 0, value * 2);
    }

    /// Stage 1c: the revert path. Called with `true` the transaction mines
    /// with status 0, so the MPC attests it `failed` over an EMPTY output
    /// (packed respond width 0). Called with `false` it is a plain
    /// single-bool method like isEven. Still pure: the outcome depends on
    /// the argument alone.
    function revertIf(bool shouldRevert) external pure returns (bool success) {
        require(!shouldRevert, "SignetEvmTarget: reverted on request");
        return true;
    }
}
