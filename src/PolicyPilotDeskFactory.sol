// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPrimeAdmin {
    function resumeTrading() external;
    function setExecutor(address next) external;
}

/// @title PolicyPilotDeskFactory
/// @notice Deploys the site's Prime, Clip and Spread desk vaults from an ordinary contract call instead of a wallet
///         contract-creation transaction. Some mobile wallets ignore the dapp's gas limit on contract creations and send
///         them with 900,000 gas, which is far below what these vaults need (2.4M-2.7M), so every such deploy ran out of
///         gas. Calls to a contract keep the dapp's gas limit.
/// @dev Only the three known creation bytecodes are accepted (prefix length + keccak checked), so nothing else can ever
///      run with this factory as msg.sender. Constructor arguments follow the bytecode and are data only. Vaults are
///      created with zero value: the creator deposits in a second, ordinary call, so shares are credited to them.
///      The factory becomes the Prime vault's `admin`; the creator keeps those powers through the forwarders below.
///      The factory holds no funds and has no payable function.
contract PolicyPilotDeskFactory {
    error UnknownKind();
    error UnknownBytecode();
    error DeployFailed();
    error NotCreator();

    uint8 public constant PRIME = 0;
    uint8 public constant CLIP = 1;
    uint8 public constant SPREAD = 2;

    bytes32 public immutable primeHash;
    bytes32 public immutable clipHash;
    bytes32 public immutable spreadHash;
    uint256 public immutable primeLen;
    uint256 public immutable clipLen;
    uint256 public immutable spreadLen;

    mapping(address vault => address creator) public creatorOf;
    mapping(address vault => uint8 kind) public kindOf;
    mapping(address creator => address[] vaults) internal _vaults;

    event DeskCreated(address indexed creator, address indexed vault, uint8 indexed kind);

    constructor(bytes32[3] memory hashes, uint256[3] memory lens) {
        primeHash = hashes[0];
        clipHash = hashes[1];
        spreadHash = hashes[2];
        primeLen = lens[0];
        clipLen = lens[1];
        spreadLen = lens[2];
    }

    function _code(uint8 kind) internal view returns (bytes32 h, uint256 len) {
        if (kind == PRIME) return (primeHash, primeLen);
        if (kind == CLIP) return (clipHash, clipLen);
        if (kind == SPREAD) return (spreadHash, spreadLen);
        revert UnknownKind();
    }

    /// @param initcode The vault's creation bytecode followed by its ABI-encoded constructor arguments.
    function create(uint8 kind, bytes calldata initcode) external returns (address vault) {
        (bytes32 h, uint256 len) = _code(kind);
        if (len == 0 || initcode.length < len || keccak256(initcode[:len]) != h) revert UnknownBytecode();
        bytes memory code = initcode;
        assembly ("memory-safe") {
            vault := create(0, add(code, 0x20), mload(code))
        }
        if (vault == address(0)) revert DeployFailed();
        creatorOf[vault] = msg.sender;
        kindOf[vault] = kind;
        _vaults[msg.sender].push(vault);
        emit DeskCreated(msg.sender, vault, kind);
    }

    function vaultsOf(address creator) external view returns (address[] memory) {
        return _vaults[creator];
    }

    modifier onlyCreator(address vault) {
        if (creatorOf[vault] != msg.sender || kindOf[vault] != PRIME) revert NotCreator();
        _;
    }

    /// @notice Prime admin power, kept by the creator: resume trading after a halt.
    function primeResumeTrading(address vault) external onlyCreator(vault) {
        IPrimeAdmin(vault).resumeTrading();
    }

    /// @notice Prime admin power, kept by the creator: change the executor.
    function primeSetExecutor(address vault, address next) external onlyCreator(vault) {
        IPrimeAdmin(vault).setExecutor(next);
    }
}
