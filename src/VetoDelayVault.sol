// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IVaultAccounting} from "./IVaultAccounting.sol";

/// @title VetoDelayVault
/// @notice The agent proposes a native-MON payment. Anyone may release it after an immutable delay.
///         Until release, the owner or a guardian can cancel. The guardian cannot withdraw, retarget
///         payees, or shorten the delay. A proposal does not reserve funds; release re-checks policy.
/// @dev ALPHA, UNAUDITED. Not deployed. Minimum delay is 15 minutes so this cannot be configured
///      into an instant-settlement AgentVault.
contract VetoDelayVault is ReentrancyGuard {
    error NotOwner();
    error NotExecutor();
    error NotGuardian();
    error Paused();
    error ZeroAddress();
    error ZeroAmount();
    error RecipientNotAllowed(address recipient);
    error ForbiddenRecipient(address recipient);
    error GuardianIsExecutor();
    error BadGuardian();
    error DelayTooShort(uint256 delay, uint256 minimum);
    error PerPaymentCapExceeded(uint256 amount, uint256 cap);
    error BudgetExceeded(uint256 requested, uint256 remaining);
    error RequestAlreadyUsed(bytes32 requestId);
    error UnknownProposal(bytes32 requestId);
    error ProposalCancelled(bytes32 requestId);
    error AlreadyReleased(bytes32 requestId);
    error TooEarly(uint64 readyAt);
    error VaultCapExceeded(uint256 newBalance, uint256 cap);
    error InsufficientBalance(uint256 requested, uint256 balance);
    error ReserveBreached(uint256 remaining, uint256 floor);
    error ReserveAboveCap(uint256 floor, uint256 cap);
    error TransferFailed();
    error DirectTransferDisabled();

    event Deposited(address indexed from, uint256 amount, uint256 balance);
    event Withdrawn(address indexed to, uint256 amount, uint256 balance);
    event Proposed(bytes32 indexed requestId, address indexed recipient, uint256 amount, uint64 readyAt);
    event Cancelled(bytes32 indexed requestId, address indexed by);
    event Released(bytes32 indexed requestId, address indexed recipient, uint256 amount, uint256 totalSpent);
    event RecipientSet(address indexed recipient, bool allowed);
    event ExecutorSet(address indexed executor);
    event GuardianSet(address indexed guardian);
    event PerPaymentCapSet(uint256 cap);
    event BudgetSet(uint256 budget);
    event ReserveFloorSet(uint256 floor);
    event PausedSet(bool paused);

    uint64 public constant MIN_DELAY = 15 minutes;

    struct Proposal {
        address recipient;
        uint256 amount;
        uint64 readyAt;
        bool exists;
        bool cancelled;
        bool released;
    }

    address public immutable factory;
    address public immutable owner;
    uint256 public immutable vaultCap;
    uint64 public immutable delay;
    address public executor;
    address public guardian;
    uint256 public perPaymentCap;
    uint256 public budget;
    uint256 public reserveFloor;
    uint256 public totalSpent;
    bool public paused;
    mapping(address => bool) public allowedRecipient;
    mapping(bytes32 => Proposal) public proposals;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address owner_,
        address executor_,
        address guardian_,
        uint64 delay_,
        uint256 perPaymentCap_,
        uint256 budget_,
        uint256 reserveFloor_,
        uint256 vaultCap_,
        address[] memory recipients
    ) {
        if (owner_ == address(0) || executor_ == address(0)) revert ZeroAddress();
        if (delay_ < MIN_DELAY) revert DelayTooShort(delay_, MIN_DELAY);
        if (reserveFloor_ > vaultCap_) revert ReserveAboveCap(reserveFloor_, vaultCap_);
        if (guardian_ == executor_) revert GuardianIsExecutor();
        if (guardian_ == address(this) || guardian_ == msg.sender) revert BadGuardian();
        factory = msg.sender;
        owner = owner_;
        executor = executor_;
        guardian = guardian_;
        delay = delay_;
        perPaymentCap = perPaymentCap_;
        budget = budget_;
        reserveFloor = reserveFloor_;
        vaultCap = vaultCap_;
        emit ExecutorSet(executor_);
        emit GuardianSet(guardian_);
        emit PerPaymentCapSet(perPaymentCap_);
        emit BudgetSet(budget_);
        emit ReserveFloorSet(reserveFloor_);
        for (uint256 i; i < recipients.length; ++i) {
            if (recipients[i] == address(0)) revert ZeroAddress();
            allowedRecipient[recipients[i]] = true;
            emit RecipientSet(recipients[i], true);
        }
    }

    receive() external payable {
        revert DirectTransferDisabled();
    }

    function remainingBudget() public view returns (uint256) {
        return budget > totalSpent ? budget - totalSpent : 0;
    }

    function deposit() external payable nonReentrant {
        if (msg.sender != owner && msg.sender != factory) revert NotOwner();
        if (msg.value == 0) revert ZeroAmount();
        if (address(this).balance > vaultCap) revert VaultCapExceeded(address(this).balance, vaultCap);
        IVaultAccounting(factory).noteIn(msg.value);
        emit Deposited(owner, msg.value, address(this).balance);
    }

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

    /// @notice Agent files a payment. Funds stay put until release. The request id cannot be reused, even after a cancel.
    function propose(bytes32 requestId, address payable recipient, uint256 amount) external {
        if (msg.sender != executor) revert NotExecutor();
        if (paused) revert Paused();
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(this) || recipient == factory) revert ForbiddenRecipient(recipient);
        if (!allowedRecipient[recipient]) revert RecipientNotAllowed(recipient);
        if (proposals[requestId].exists) revert RequestAlreadyUsed(requestId);
        if (amount > perPaymentCap) revert PerPaymentCapExceeded(amount, perPaymentCap);
        uint64 readyAt = uint64(block.timestamp) + delay;
        proposals[requestId] = Proposal({recipient: recipient, amount: amount, readyAt: readyAt, exists: true, cancelled: false, released: false});
        emit Proposed(requestId, recipient, amount, readyAt);
    }

    /// @notice Owner or guardian stops a proposal that has not been released. Pause is not required.
    function cancel(bytes32 requestId) external {
        if (msg.sender != owner && msg.sender != guardian) revert NotGuardian();
        Proposal storage p = proposals[requestId];
        if (!p.exists) revert UnknownProposal(requestId);
        if (p.released) revert AlreadyReleased(requestId);
        if (p.cancelled) revert ProposalCancelled(requestId);
        p.cancelled = true;
        emit Cancelled(requestId, msg.sender);
    }

    /// @notice Anyone can finalize a proposal once the delay has elapsed. Policy is checked again here.
    function release(bytes32 requestId) external nonReentrant {
        Proposal storage p = proposals[requestId];
        if (!p.exists) revert UnknownProposal(requestId);
        if (p.cancelled) revert ProposalCancelled(requestId);
        if (p.released) revert AlreadyReleased(requestId);
        if (block.timestamp < p.readyAt) revert TooEarly(p.readyAt);
        if (paused) revert Paused();
        if (!allowedRecipient[p.recipient]) revert RecipientNotAllowed(p.recipient);
        uint256 amount = p.amount;
        if (amount > perPaymentCap) revert PerPaymentCapExceeded(amount, perPaymentCap);
        uint256 rem = remainingBudget();
        if (amount > rem) revert BudgetExceeded(amount, rem);
        if (amount > address(this).balance) revert InsufficientBalance(amount, address(this).balance);
        uint256 left = address(this).balance - amount;
        if (left < reserveFloor) revert ReserveBreached(left, reserveFloor);
        p.released = true;
        totalSpent += amount;
        IVaultAccounting(factory).noteOut(amount);
        (bool ok,) = p.recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Released(requestId, p.recipient, amount, totalSpent);
    }

    function setRecipient(address r, bool allowed) external onlyOwner {
        if (r == address(0)) revert ZeroAddress();
        allowedRecipient[r] = allowed;
        emit RecipientSet(r, allowed);
    }

    function setExecutor(address e) external onlyOwner {
        if (e == address(0)) revert ZeroAddress();
        if (guardian != address(0) && e == guardian) revert GuardianIsExecutor();
        executor = e;
        emit ExecutorSet(e);
    }

    function setGuardian(address g) external onlyOwner {
        if (g == address(this) || g == factory) revert BadGuardian();
        if (g != address(0) && g == executor) revert GuardianIsExecutor();
        guardian = g;
        emit GuardianSet(g);
    }

    function setPerPaymentCap(uint256 c) external onlyOwner {
        perPaymentCap = c;
        emit PerPaymentCapSet(c);
    }

    function setBudget(uint256 b) external onlyOwner {
        budget = b;
        emit BudgetSet(b);
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
