// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IVaultAccounting} from "./IVaultAccounting.sol";

/// @title EpochAllowanceVault
/// @notice Native-MON vault whose agent may spend a fresh allowance each epoch. Unspent allowance
///         does not roll forward, so a quiet period cannot stockpile a drainable balance.
///         A reserve floor is owner money: the agent cannot spend through it.
/// @dev ALPHA, UNAUDITED. Not the live AgentVault. Epoch length is at least one hour so a boundary
///      burst cannot stack two windows the way a rolling 24h limit can.
contract EpochAllowanceVault is ReentrancyGuard {
    error NotOwner();
    error NotExecutor();
    error Paused();
    error ZeroAddress();
    error ZeroAmount();
    error RecipientNotAllowed(address recipient);
    error ForbiddenRecipient(address recipient);
    error PerPaymentCapExceeded(uint256 amount, uint256 cap);
    error EpochAllowanceExceeded(uint256 requested, uint256 remaining);
    error RequestAlreadyExecuted(bytes32 requestId);
    error VaultCapExceeded(uint256 newBalance, uint256 cap);
    error InsufficientBalance(uint256 requested, uint256 balance);
    error ReserveBreached(uint256 remaining, uint256 floor);
    error ReserveAboveCap(uint256 floor, uint256 cap);
    error EpochTooShort(uint256 length, uint256 minimum);
    error TransferFailed();
    error DirectTransferDisabled();

    event Deposited(address indexed from, uint256 amount, uint256 balance);
    event Withdrawn(address indexed to, uint256 amount, uint256 balance);
    event Executed(bytes32 indexed requestId, address indexed recipient, uint256 amount, uint256 epochSpent);
    event EpochRolled(uint64 indexed index);
    event RecipientSet(address indexed recipient, bool allowed);
    event ExecutorSet(address indexed executor);
    event PerPaymentCapSet(uint256 cap);
    event EpochAllowanceSet(uint256 allowance);
    event ReserveFloorSet(uint256 floor);
    event PausedSet(bool paused);

    uint256 public constant MIN_EPOCH = 1 hours;

    address public immutable factory;
    address public immutable owner;
    uint256 public immutable vaultCap;
    uint256 public immutable epochLength;
    address public executor;
    uint256 public perPaymentCap;
    uint256 public epochAllowance;
    uint256 public reserveFloor;
    uint64 public epochIndex;
    uint256 public epochSpent;
    bool public paused;
    mapping(address => bool) public allowedRecipient;
    mapping(bytes32 => bool) public executed;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address owner_,
        address executor_,
        uint256 perPaymentCap_,
        uint256 epochAllowance_,
        uint256 epochLength_,
        uint256 reserveFloor_,
        uint256 vaultCap_,
        address[] memory recipients
    ) {
        if (owner_ == address(0) || executor_ == address(0)) revert ZeroAddress();
        if (epochLength_ < MIN_EPOCH) revert EpochTooShort(epochLength_, MIN_EPOCH);
        if (reserveFloor_ > vaultCap_) revert ReserveAboveCap(reserveFloor_, vaultCap_);
        factory = msg.sender;
        owner = owner_;
        executor = executor_;
        perPaymentCap = perPaymentCap_;
        epochAllowance = epochAllowance_;
        epochLength = epochLength_;
        reserveFloor = reserveFloor_;
        vaultCap = vaultCap_;
        epochIndex = uint64(block.timestamp / epochLength_);
        emit ExecutorSet(executor_);
        emit PerPaymentCapSet(perPaymentCap_);
        emit EpochAllowanceSet(epochAllowance_);
        emit ReserveFloorSet(reserveFloor_);
        for (uint256 i; i < recipients.length; ++i) {
            if (recipients[i] == address(0)) revert ZeroAddress();
            allowedRecipient[recipients[i]] = true;
            emit RecipientSet(recipients[i], true);
        }
    }

    /// @dev Reject naked MON. Funding goes through deposit() so the factory cap cannot be skipped.
    receive() external payable {
        revert DirectTransferDisabled();
    }

    /// @notice Spent amount in the active epoch. Raw `epochSpent` stays stale until the next agent call.
    function currentEpochSpent() public view returns (uint256) {
        uint64 idx = uint64(block.timestamp / epochLength);
        return idx == epochIndex ? epochSpent : 0;
    }

    function remainingEpochAllowance() public view returns (uint256) {
        uint256 spent = currentEpochSpent();
        return epochAllowance > spent ? epochAllowance - spent : 0;
    }

    function deposit() external payable nonReentrant {
        if (msg.sender != owner && msg.sender != factory) revert NotOwner();
        if (msg.value == 0) revert ZeroAmount();
        if (address(this).balance > vaultCap) revert VaultCapExceeded(address(this).balance, vaultCap);
        IVaultAccounting(factory).noteIn(msg.value);
        emit Deposited(owner, msg.value, address(this).balance);
    }

    /// @notice Owner withdrawal may cross the reserve floor. The agent cannot.
    function withdraw(address payable to, uint256 amount) public onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > address(this).balance) revert InsufficientBalance(amount, address(this).balance);
        IVaultAccounting(factory).noteOut(amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(to, amount, address(this).balance);
    }

    function emergencyWithdrawAll() external onlyOwner {
        if (!paused) {
            paused = true;
            emit PausedSet(true);
        }
        uint256 bal = address(this).balance;
        if (bal > 0) withdraw(payable(owner), bal);
    }

    function execute(bytes32 requestId, address payable recipient, uint256 amount) external nonReentrant {
        if (msg.sender != executor) revert NotExecutor();
        if (paused) revert Paused();
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(this) || recipient == factory) revert ForbiddenRecipient(recipient);
        if (!allowedRecipient[recipient]) revert RecipientNotAllowed(recipient);
        if (executed[requestId]) revert RequestAlreadyExecuted(requestId);
        if (amount > perPaymentCap) revert PerPaymentCapExceeded(amount, perPaymentCap);
        _syncEpoch();
        uint256 rem = epochAllowance > epochSpent ? epochAllowance - epochSpent : 0;
        if (amount > rem) revert EpochAllowanceExceeded(amount, rem);
        if (amount > address(this).balance) revert InsufficientBalance(amount, address(this).balance);
        uint256 left = address(this).balance - amount;
        if (left < reserveFloor) revert ReserveBreached(left, reserveFloor);
        executed[requestId] = true;
        epochSpent += amount;
        IVaultAccounting(factory).noteOut(amount);
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Executed(requestId, recipient, amount, epochSpent);
    }

    function _syncEpoch() internal {
        uint64 idx = uint64(block.timestamp / epochLength);
        if (idx == epochIndex) return;
        epochIndex = idx;
        epochSpent = 0;
        emit EpochRolled(idx);
    }

    function setRecipient(address r, bool allowed) external onlyOwner {
        if (r == address(0)) revert ZeroAddress();
        allowedRecipient[r] = allowed;
        emit RecipientSet(r, allowed);
    }

    function setExecutor(address e) external onlyOwner {
        if (e == address(0)) revert ZeroAddress();
        executor = e;
        emit ExecutorSet(e);
    }

    function setPerPaymentCap(uint256 c) external onlyOwner {
        perPaymentCap = c;
        emit PerPaymentCapSet(c);
    }

    function setEpochAllowance(uint256 allowance) external onlyOwner {
        epochAllowance = allowance;
        emit EpochAllowanceSet(allowance);
    }

    function setReserveFloor(uint256 floor) external onlyOwner {
        if (floor > vaultCap) revert ReserveAboveCap(floor, vaultCap);
        reserveFloor = floor;
        emit ReserveFloorSet(floor);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }
}
