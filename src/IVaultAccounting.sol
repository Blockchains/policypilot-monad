// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Factory hook implemented by NovelVaultFactory. Vaults report MON that enters or leaves
///         through deposit, withdraw, execute, and release. Naked transfers are rejected by the vaults.
interface IVaultAccounting {
    function noteIn(uint256 amount) external;
    function noteOut(uint256 amount) external;
}
