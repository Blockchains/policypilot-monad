// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IVaultAccounting} from "./IVaultAccounting.sol";

/// @title SessionVault
/// @notice One native-MON vault, many concurrent agent sessions. Each session has its own key,
///         clock, allowance, and payee list. The key cannot extend the clock, raise the allowance,
///         or add payees. A session window cannot exceed 30 days; standing authority belongs on AgentVault.
/// @dev ALPHA, UNAUDITED. Not deployed. A reserve floor is owner money the session keys cannot spend.
contract SessionVault is ReentrancyGuard {
    error NotOwner();
    error NotSessionKey();
    error Paused();
    error ZeroAddress();
    error ZeroAmount();
    error BadWindow();
    error WindowTooLong(uint256 length, uint256 maximum);
    error TooManyRecipients(uint256 count, uint256 maximum);
    error UnknownSession(uint256 id);
    error AlreadyRevoked(uint256 id);
    error SessionNotStarted(uint256 id, uint64 notBefore);
    error SessionExpired(uint256 id, uint64 notAfter);
    error RecipientNotAllowed(address recipient);
    error ForbiddenRecipient(address recipient);
    error PerPaymentCapExceeded(uint256 amount, uint256 cap);
    error SessionAllowanceExceeded(uint256 requested, uint256 remaining);
    error RequestAlreadyExecuted(bytes32 requestId);
    error VaultCapExceeded(uint256 newBalance, uint256 cap);
    error InsufficientBalance(uint256 requested, uint256 balance);
    error ReserveBreached(uint256 remaining, uint256 floor);
    error ReserveAboveCap(uint256 floor, uint256 cap);
    error TransferFailed();
    error DirectTransferDisabled();

    event Deposited(address indexed from, uint256 amount, uint256 balance);
    event Withdrawn(address indexed to, uint256 amount, uint256 balance);
    event SessionOpened(uint256 indexed id, address indexed key, uint64 notBefore, uint64 notAfter, uint256 allowance);
    event SessionRevoked(uint256 indexed id);
    event Executed(uint256 indexed sessionId, bytes32 indexed requestId, address indexed recipient, uint256 amount, uint256 sessionSpent);
    event PerPaymentCapSet(uint256 cap);
    event ReserveFloorSet(uint256 floor);
    event PausedSet(bool paused);

    uint256 public constant MAX_WINDOW = 30 days;
    uint256 public constant MAX_RECIPIENTS = 8;

    struct Session {
        address key;
        uint64 notBefore;
        uint64 notAfter;
        uint256 allowance;
        uint256 spent;
        bool revoked;
    }

    address public immutable factory;
    address public immutable owner;
    uint256 public immutable vaultCap;
    uint256 public perPaymentCap;
    uint256 public reserveFloor;
    bool public paused;
    uint256 public sessionCount;
    mapping(uint256 => Session) public sessions;
    mapping(uint256 => mapping(address => bool)) public sessionRecipient;
    mapping(bytes32 => bool) public executed;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, uint256 perPaymentCap_, uint256 reserveFloor_, uint256 vaultCap_) {
        if (owner_ == address(0)) revert ZeroAddress();
        if (reserveFloor_ > vaultCap_) revert ReserveAboveCap(reserveFloor_, vaultCap_);
        factory = msg.sender;
        owner = owner_;
        perPaymentCap = perPaymentCap_;
        reserveFloor = reserveFloor_;
        vaultCap = vaultCap_;
        emit PerPaymentCapSet(perPaymentCap_);
        emit ReserveFloorSet(reserveFloor_);
    }

    receive() external payable {
        revert DirectTransferDisabled();
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

    /// @notice Owner opens a session. The session key is not msg.sender and cannot call this.
    function openSession(address key, uint64 notBefore, uint64 notAfter, uint256 allowance, address[] calldata recipients)
        external
        onlyOwner
        returns (uint256 id)
    {
        if (key == address(0) || key == address(this) || key == factory) revert ZeroAddress();
        if (notAfter <= notBefore || notAfter <= block.timestamp) revert BadWindow();
        uint256 span = uint256(notAfter) - uint256(notBefore);
        if (span > MAX_WINDOW) revert WindowTooLong(span, MAX_WINDOW);
        if (allowance == 0) revert ZeroAmount();
        if (recipients.length == 0 || recipients.length > MAX_RECIPIENTS) {
            revert TooManyRecipients(recipients.length, MAX_RECIPIENTS);
        }
        id = ++sessionCount;
        sessions[id] = Session({key: key, notBefore: notBefore, notAfter: notAfter, allowance: allowance, spent: 0, revoked: false});
        for (uint256 i; i < recipients.length; ++i) {
            if (recipients[i] == address(0) || recipients[i] == address(this) || recipients[i] == factory) revert ZeroAddress();
            sessionRecipient[id][recipients[i]] = true;
        }
        emit SessionOpened(id, key, notBefore, notAfter, allowance);
    }

    function revokeSession(uint256 id) external onlyOwner {
        Session storage s = sessions[id];
        if (s.key == address(0)) revert UnknownSession(id);
        if (s.revoked) revert AlreadyRevoked(id);
        s.revoked = true;
        emit SessionRevoked(id);
    }

    /// @notice Session key pays one of its own payees. Request ids are unique across every session on this vault.
    function execute(uint256 id, bytes32 requestId, address payable recipient, uint256 amount) external nonReentrant {
        Session storage s = sessions[id];
        if (s.key == address(0)) revert UnknownSession(id);
        if (msg.sender != s.key) revert NotSessionKey();
        if (paused) revert Paused();
        if (s.revoked) revert AlreadyRevoked(id);
        if (block.timestamp < s.notBefore) revert SessionNotStarted(id, s.notBefore);
        if (block.timestamp >= s.notAfter) revert SessionExpired(id, s.notAfter);
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(this) || recipient == factory) revert ForbiddenRecipient(recipient);
        if (!sessionRecipient[id][recipient]) revert RecipientNotAllowed(recipient);
        if (executed[requestId]) revert RequestAlreadyExecuted(requestId);
        if (amount > perPaymentCap) revert PerPaymentCapExceeded(amount, perPaymentCap);
        uint256 rem = s.allowance > s.spent ? s.allowance - s.spent : 0;
        if (amount > rem) revert SessionAllowanceExceeded(amount, rem);
        if (amount > address(this).balance) revert InsufficientBalance(amount, address(this).balance);
        uint256 left = address(this).balance - amount;
        if (left < reserveFloor) revert ReserveBreached(left, reserveFloor);
        executed[requestId] = true;
        s.spent += amount;
        IVaultAccounting(factory).noteOut(amount);
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Executed(id, requestId, recipient, amount, s.spent);
    }

    function setPerPaymentCap(uint256 c) external onlyOwner {
        perPaymentCap = c;
        emit PerPaymentCapSet(c);
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
