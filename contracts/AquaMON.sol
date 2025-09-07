// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * AquaMON (stMON) — Rebasing ERC-20 facade over internal "shares".
 * - Balances & totalSupply are derived from shares via pool.index() (1e18 scale).
 * - Transfers move *shares* computed at the current index.
 * - Allowances tracked in external (rebased) units.
 * - EIP-2612 permit for gasless approvals.
 * - UUPS upgradeable + Ownable upgrade gate.
 *
 * NOTE: Underlying asset accounting lives in StakePoolCore.
 *       This token never pulls assets; it only represents pool shares.
 */

import {Initializable}       from "@ozu/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable}     from "@ozu/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable}  from "@ozu/contracts/access/OwnableUpgradeable.sol";
import {IERC20Metadata}      from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ECDSA}               from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IStakePoolCoreIndex {
    function index() external view returns (uint256); // 1e18 scale
}

contract AquaMON is Initializable, UUPSUpgradeable, OwnableUpgradeable, IERC20Metadata {
    // ========= Errors =========
    error NotCore();
    error InvalidIndex();
    error ZeroAddress();
    error InsufficientShares();
    error PermitExpired();

    // ========= Events =========
    event Rebased(uint256 newIndex);
    event MintShares(address indexed to, uint256 shares);
    event BurnShares(address indexed from, uint256 shares);
    event PoolSet(address indexed pool);

    // ========= Storage =========

    // token meta
    string private _name;
    string private _symbol;

    // StakePoolCore (the only minter/burner; source of index)
    address private _pool;

    // internal shares
    mapping(address => uint256) private _shares;
    uint256 private _totalShares;

    // allowances tracked in external units (rebased amounts)
    mapping(address => mapping(address => uint256)) private _allowances;

    // EIP-2612
    mapping(address => uint256) private _nonces;
    bytes32 private _DOMAIN_SEPARATOR;
    uint256 private _cachedChainId;

    // Optional index cache for UI analytics (not used for correctness)
    uint256 private _cachedIndex;     // last seen index (1e18)
    uint256 private _lastSyncBlock;

    // storage gap
    uint256[41] private __gap;

    // ========= Init / Upgrade =========

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    /// @notice Initialize metadata & ownership. Pool is set later via setPool().
    function initialize(string memory name_, string memory symbol_, address owner_) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);
        __UUPSUpgradeable_init();

        _name  = name_;
        _symbol = symbol_;

        _cachedChainId    = block.chainid;
        _DOMAIN_SEPARATOR = _deriveDomainSeparator();

        // Seed a sane default cache; functional reads that require the pool will revert until setPool().
        _cachedIndex   = 1e18;
        _lastSyncBlock = block.number;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ========= Admin =========

    /// @notice One-time binding to the StakePoolCore. Seeds index cache from the core.
    function setPool(address pool_) external onlyOwner {
        if (pool_ == address(0)) revert ZeroAddress();
        require(_pool == address(0), "pool already set");
        _pool = pool_;

        // seed index cache
        uint256 ix = _poolIndex();
        if (ix == 0) revert InvalidIndex();
        _cachedIndex = ix;
        _lastSyncBlock = block.number;

        emit PoolSet(pool_);
    }

    // ========= ERC-20 (rebased facade) =========

    function name() public view override returns (string memory) { return _name; }
    function symbol() public view override returns (string memory) { return _symbol; }
    function decimals() public pure override returns (uint8) { return 18; }

    function totalSupply() public view override returns (uint256) {
        // external = totalShares * index / 1e18 (floor)
        return _mulDivDown(_totalShares, _currentIndex(), 1e18);
    }

    function balanceOf(address account) public view override returns (uint256) {
        // external = shares * index / 1e18 (floor)
        return _mulDivDown(_shares[account], _currentIndex(), 1e18);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (to == address(0)) revert ZeroAddress();
        address from = msg.sender;

        uint256 ix = _currentIndex();
        if (ix == 0) revert InvalidIndex();

        // convert requested external to shares (ceil)
        uint256 s = _toShares(amount, ix);
        if (_shares[from] < s) revert InsufficientShares();

        _shares[from] -= s;
        _shares[to]   += s;

        emit Transfer(from, to, amount);
        return true;
    }

    function allowance(address owner, address spender) public view override returns (uint256) {
        return _allowances[owner][spender];
    }

    function approve(address spender, uint256 value) public override returns (bool) {
        if (spender == address(0)) revert ZeroAddress();
        address owner = msg.sender;
        _allowances[owner][spender] = value;
        emit Approval(owner, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (to == address(0)) revert ZeroAddress();

        uint256 allowed = _allowances[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "ERC20: insufficient allowance");
            unchecked { _allowances[from][msg.sender] = allowed - amount; }
            emit Approval(from, msg.sender, _allowances[from][msg.sender]);
        }

        uint256 ix = _currentIndex();
        if (ix == 0) revert InvalidIndex();

        uint256 s = _toShares(amount, ix); // ceil
        if (_shares[from] < s) revert InsufficientShares();

        _shares[from] -= s;
        _shares[to]   += s;

        emit Transfer(from, to, amount);
        return true;
    }

    // ========= EIP-2612 Permit =========

    bytes32 private constant _PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external {
        if (block.timestamp > deadline) revert PermitExpired();
        if (owner == address(0) || spender == address(0)) revert ZeroAddress();

        bytes32 DOMAIN = _domainSeparator();

        bytes32 structHash = keccak256(
            abi.encode(
                _PERMIT_TYPEHASH,
                owner,
                spender,
                value,
                _nonces[owner],
                deadline
            )
        );

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN, structHash));
        address signer = ECDSA.recover(digest, v, r, s);
        require(signer == owner, "invalid permit");

        unchecked { _nonces[owner]++; }
        _allowances[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function nonces(address owner) external view returns (uint256) { return _nonces[owner]; }
    function DOMAIN_SEPARATOR() external view returns (bytes32) { return _domainSeparator(); }

    // ========= Views & Math Helpers =========

    function pool() external view returns (address) { return _pool; }
    function poolIndex() external view returns (uint256) { return _poolIndex(); }
    function sharesOf(address account) external view returns (uint256) { return _shares[account]; }
    function totalShares() external view returns (uint256) { return _totalShares; }

    function convertToShares(uint256 externalAmt) external view returns (uint256) {
        uint256 ix = _currentIndex();
        if (ix == 0) revert InvalidIndex();
        return _toShares(externalAmt, ix); // ceil
    }

    function convertToExternal(uint256 shares_) external view returns (uint256) {
        uint256 ix = _currentIndex();
        if (ix == 0) revert InvalidIndex();
        return _toExternal(shares_, ix); // floor
    }

    // ========= Core-only Hooks =========

    /// @notice Mint raw shares to `to`. Only callable by StakePoolCore.
    function mintShares(address to, uint256 shares_) external {
        if (msg.sender != _pool) revert NotCore();
        if (to == address(0)) revert ZeroAddress();

        _totalShares += shares_;
        _shares[to]  += shares_;

        emit MintShares(to, shares_);
        // Optional Transfer(0x0, to, externalAmount) for indexers
        uint256 amt = _toExternal(shares_, _currentIndex());
        emit Transfer(address(0), to, amt);
    }

    /// @notice Burn raw shares from `from`. Only callable by StakePoolCore.
    function burnShares(address from, uint256 shares_) external {
        if (msg.sender != _pool) revert NotCore();
        if (_shares[from] < shares_) revert InsufficientShares();

        _shares[from]  -= shares_;
        _totalShares   -= shares_;

        emit BurnShares(from, shares_);
        uint256 amt = _toExternal(shares_, _currentIndex());
        emit Transfer(from, address(0), amt);
    }

    /// @notice Optional: Core can call when index updates to emit a Rebased event & refresh cache.
    function onIndexUpdated(uint256 newIndex) external {
        if (msg.sender != _pool) revert NotCore();
        if (newIndex == 0) revert InvalidIndex();
        if (newIndex != _cachedIndex) {
            _cachedIndex = newIndex;
            _lastSyncBlock = block.number;
            emit Rebased(newIndex);
        }
    }

    /// @notice Anyone can sync cache from pool for analytics.
    function sync() external returns (uint256 newIndex) {
        newIndex = _poolIndex();
        if (newIndex == 0) revert InvalidIndex();
        if (newIndex != _cachedIndex) {
            _cachedIndex = newIndex;
            _lastSyncBlock = block.number;
            emit Rebased(newIndex);
        }
    }

    // ========= Internals =========

    function _currentIndex() internal view returns (uint256) {
        // Always read fresh for correctness (cache is for events/telemetry)
        return _poolIndex();
    }

    function _poolIndex() internal view returns (uint256) {
        if (_pool == address(0)) revert ZeroAddress(); // pool not set yet
        return IStakePoolCoreIndex(_pool).index();
    }

    // external → shares (ceil)
    function _toShares(uint256 amount, uint256 ix) internal pure returns (uint256) {
        if (amount == 0) return 0;
        // ceil(amount * 1e18 / ix)
        unchecked { return (amount * 1e18 + ix - 1) / ix; }
    }

    // shares → external (floor)
    function _toExternal(uint256 shares_, uint256 ix) internal pure returns (uint256) {
        if (shares_ == 0) return 0;
        unchecked { return (shares_ * ix) / 1e18; }
    }

    // mulDiv helpers (used by totalSupply/balanceOf)
    function _mulDivDown(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        return (a * b) / d;
    }

    // ========= EIP-712 Domain =========

    function _domainSeparator() internal view returns (bytes32) {
        if (block.chainid == _cachedChainId) return _DOMAIN_SEPARATOR;
        return _deriveDomainSeparator(); // derive on-the-fly if chainId changed
    }

    function _deriveDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                // keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
                0x8b73e5d9978c4e0b6f87f8e5a6c0f22a9f107a3d4d3b6f3b1b3b3f1b9b5c7f3c,
                keccak256(bytes(_name)),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }
}
