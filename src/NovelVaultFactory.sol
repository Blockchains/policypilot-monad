// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EpochAllowanceVault} from "./EpochAllowanceVault.sol";
import {SessionVault} from "./SessionVault.sol";
import {VetoDelayVault} from "./VetoDelayVault.sol";

/// @title NovelVaultFactory
/// @notice Creates EpochAllowanceVault, SessionVault, and VetoDelayVault. No owner, no admin, no upgrade.
///         Separate from AgentVaultFactory so the live factory bytecode and caps stay untouched.
/// @dev ALPHA, UNAUDITED. Not deployed.
contract NovelVaultFactory {
    error NotVault();
    error GlobalCapExceeded(uint256 newTotal, uint256 cap);

    uint8 public constant KIND_EPOCH = 1;
    uint8 public constant KIND_SESSION = 2;
    uint8 public constant KIND_VETO = 3;

    event VaultCreated(address indexed owner, address indexed vault, uint8 kind);

    uint256 public immutable vaultCap;
    uint256 public immutable globalCap;
    uint256 public totalDeposited;
    mapping(address => bool) public isVault;
    mapping(address => uint8) public kindOf;
    mapping(address => address[]) internal _vaultsOf;
    address[] public allVaults;

    constructor(uint256 vaultCap_, uint256 globalCap_) {
        vaultCap = vaultCap_;
        globalCap = globalCap_;
    }

    function createEpochVault(
        address executor,
        uint256 perPaymentCap,
        uint256 epochAllowance,
        uint256 epochLength,
        uint256 reserveFloor,
        address[] calldata recipients
    ) external payable returns (EpochAllowanceVault v) {
        v = new EpochAllowanceVault(
            msg.sender, executor, perPaymentCap, epochAllowance, epochLength, reserveFloor, vaultCap, recipients
        );
        _register(address(v), msg.sender, KIND_EPOCH);
        if (msg.value > 0) v.deposit{value: msg.value}();
    }

    function createSessionVault(uint256 perPaymentCap, uint256 reserveFloor) external payable returns (SessionVault v) {
        v = new SessionVault(msg.sender, perPaymentCap, reserveFloor, vaultCap);
        _register(address(v), msg.sender, KIND_SESSION);
        if (msg.value > 0) v.deposit{value: msg.value}();
    }

    function createVetoVault(
        address executor,
        address guardian,
        uint64 delay,
        uint256 perPaymentCap,
        uint256 budget,
        uint256 reserveFloor,
        address[] calldata recipients
    ) external payable returns (VetoDelayVault v) {
        v = new VetoDelayVault(
            msg.sender, executor, guardian, delay, perPaymentCap, budget, reserveFloor, vaultCap, recipients
        );
        _register(address(v), msg.sender, KIND_VETO);
        if (msg.value > 0) v.deposit{value: msg.value}();
    }

    function noteIn(uint256 amount) external {
        if (!isVault[msg.sender]) revert NotVault();
        uint256 t = totalDeposited + amount;
        if (t > globalCap) revert GlobalCapExceeded(t, globalCap);
        totalDeposited = t;
    }

    function noteOut(uint256 amount) external {
        if (!isVault[msg.sender]) revert NotVault();
        totalDeposited = totalDeposited >= amount ? totalDeposited - amount : 0;
    }

    function vaultsOf(address owner) external view returns (address[] memory) {
        return _vaultsOf[owner];
    }

    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }

    function _register(address v, address owner_, uint8 kind) internal {
        isVault[v] = true;
        kindOf[v] = kind;
        _vaultsOf[owner_].push(v);
        allVaults.push(v);
        emit VaultCreated(owner_, v, kind);
    }
}
