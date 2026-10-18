// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title  UnlimitedAgentVault (PolicyPilot v4)
/// @notice ALPHA, UNAUDITED. Native-MON vault owned by one wallet, with NO spending limits and NO allowlists:
///         - no vault cap, no per-payment / per-tx cap, no budget, no token approval cap;
///         - the agent (executor) may pay ANY recipient and call ANY contract with ANY calldata and MON value,
///           including ERC-20 transfer/approve. The agent can move all of the vault's funds.
///         What the owner keeps: deposit, withdraw (MON and tokens) at any time, pause, emergencyWithdrawAll,
///         and replacing the agent key with setExecutor. Nobody else (not the factory, not the deployer) can move funds.
///         Request ids are still replay-protected and an optional, agent-chosen minOut check is kept for swaps.
/// @dev    For ABI compatibility with v1-v3 readers the old policy getters remain as views that report "unlimited":
///         perPaymentCap/budget/vaultCap/tokenCap return type(uint256).max, allowedRecipient/callRule return allowed.
contract UnlimitedAgentVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error NotOwner();
    error NotExecutor();
    error Paused();
    error ZeroAddress();
    error ZeroAmount();
    error RequestAlreadyExecuted(bytes32 requestId);
    error InsufficientBalance(uint256 requested, uint256 balance);
    error TransferFailed();
    error MinOutNotMet(uint256 received, uint256 minOut);
    error CallFailed(bytes returndata);

    event Deposited(address indexed from, uint256 amount, uint256 balance);
    event Withdrawn(address indexed to, uint256 amount, uint256 balance);
    event Executed(bytes32 indexed requestId, address indexed recipient, uint256 amount, uint256 totalSpent);
    event ExecutorSet(address indexed executor);
    event PausedSet(bool paused);
    event DappCalled(bytes32 indexed requestId, address indexed target, bytes4 indexed selector, uint256 value, address outToken, uint256 received, uint256 totalSpent);
    event TokenWithdrawn(address indexed token, address indexed to, uint256 amount);

    /// @notice Always true: this vault has no spending limits and no allowlists.
    bool public constant unlimited = true;
    uint256 public constant perPaymentCap = type(uint256).max;
    uint256 public constant budget = type(uint256).max;
    uint256 public constant vaultCap = type(uint256).max;

    address public immutable factory;
    address public immutable owner;
    address public executor;
    uint256 public totalSpent; // informational only, never checked
    bool public paused;
    mapping(bytes32 => bool) public executed;

    struct CallOpts { address approveToken; uint256 approveAmount; address outToken; uint256 minOut; }

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyAgent() { if (msg.sender != executor) revert NotExecutor(); if (paused) revert Paused(); _; }

    constructor(address owner_, address executor_) {
        if (owner_ == address(0) || executor_ == address(0)) revert ZeroAddress();
        factory = msg.sender;
        owner = owner_;
        executor = executor_;
        emit ExecutorSet(executor_);
    }

    /// @dev Must stay empty: WMON.withdraw pays with a 2300-gas transfer.
    receive() external payable {}

    // ---- v1-v3 compatible "policy" views (all unlimited) ----
    function remainingBudget() external pure returns (uint256) { return type(uint256).max; }
    function allowedRecipient(address) external pure returns (bool) { return true; }
    function callRule(address, bytes4) external pure returns (bool allowed, uint8 recipientWord) { return (true, 255); }
    function tokenCap(address) external pure returns (uint256) { return type(uint256).max; }

    // ---- owner ----
    function deposit() external payable nonReentrant {
        if (msg.sender != owner && msg.sender != factory) revert NotOwner();
        if (msg.value == 0) revert ZeroAmount();
        emit Deposited(owner, msg.value, address(this).balance);
    }

    function withdraw(address payable to, uint256 amount) public onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > address(this).balance) revert InsufficientBalance(amount, address(this).balance);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(to, amount, address(this).balance);
    }

    /// @notice Emergency: pause and pull all MON back to the owner in one call.
    function emergencyWithdrawAll() external onlyOwner {
        if (!paused) { paused = true; emit PausedSet(true); }
        uint256 bal = address(this).balance;
        if (bal > 0) withdraw(payable(owner), bal);
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit TokenWithdrawn(token, to, amount);
    }

    function setExecutor(address e) external onlyOwner { if (e == address(0)) revert ZeroAddress(); executor = e; emit ExecutorSet(e); }
    function setPaused(bool p) external onlyOwner { paused = p; emit PausedSet(p); }

    // ---- agent (no limits) ----
    /// @notice Agent pays any recipient any amount up to the vault balance.
    function execute(bytes32 requestId, address payable recipient, uint256 amount) external onlyAgent nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        if (executed[requestId]) revert RequestAlreadyExecuted(requestId);
        if (amount > address(this).balance) revert InsufficientBalance(amount, address(this).balance);
        executed[requestId] = true;
        totalSpent += amount;
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Executed(requestId, recipient, amount, totalSpent);
    }

    /// @notice Agent calls any contract with any calldata and MON value. Optional exact approval (reset to 0 after)
    ///         and an optional agent-chosen minOut check on `outToken` (address(0) = MON; skipped when minOut == 0).
    function executeCall(bytes32 requestId, address target, uint256 value, bytes calldata data, CallOpts calldata o)
        external onlyAgent nonReentrant returns (bytes memory ret)
    {
        if (target == address(0)) revert ZeroAddress();
        if (executed[requestId]) revert RequestAlreadyExecuted(requestId);
        if (value > address(this).balance) revert InsufficientBalance(value, address(this).balance);
        bytes4 sel = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
        uint256 before = o.minOut == 0 ? 0 : _bal(o.outToken);
        executed[requestId] = true;
        totalSpent += value;
        if (o.approveToken != address(0)) IERC20(o.approveToken).forceApprove(target, o.approveAmount);
        bool ok;
        (ok, ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        if (o.approveToken != address(0)) IERC20(o.approveToken).forceApprove(target, 0);
        uint256 received;
        if (o.minOut != 0) {
            uint256 afterBal = _bal(o.outToken);
            received = afterBal > before ? afterBal - before : 0;
            if (received < o.minOut) revert MinOutNotMet(received, o.minOut);
        }
        emit DappCalled(requestId, target, sel, value, o.outToken, received, totalSpent);
    }

    function _bal(address token) internal view returns (uint256) {
        return token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
    }
}

/// @title  UnlimitedAgentVaultFactory (PolicyPilot v4). ALPHA, UNAUDITED.
/// @notice Anyone creates their own UnlimitedAgentVault in one transaction, with any initial deposit.
///         No owner, no admin, no upgrade path, no fee, no per-vault or global deposit cap.
contract UnlimitedAgentVaultFactory {
    event VaultCreated(address indexed owner, address indexed vault, address indexed executor);

    bool public constant unlimited = true;
    mapping(address => bool) public isVault;
    mapping(address => address[]) internal _vaultsOf;
    address[] public allVaults;

    function createVault(address executor) external payable returns (UnlimitedAgentVault v) {
        v = new UnlimitedAgentVault(msg.sender, executor);
        isVault[address(v)] = true;
        _vaultsOf[msg.sender].push(address(v));
        allVaults.push(address(v));
        emit VaultCreated(msg.sender, address(v), executor);
        if (msg.value > 0) v.deposit{value: msg.value}();
    }

    function vaultsOf(address owner) external view returns (address[] memory) { return _vaultsOf[owner]; }
    function vaultCount() external view returns (uint256) { return allVaults.length; }
}
