// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * StakePoolCore — v1.1 (Spec-aligned)
 * - UUPS upgradeable, Ownable, Pausable, ReentrancyGuard.
 * - ERC-4626-like surface (deposit/mint/withdraw/redeem + previews + max*).
 * - Single source of truth: _totalAssets, _totalShares, _index (1e18).
 * - AquaMON holds user "shares"; Core mints/burns shares via internal wrappers.
 * - Gasless-friendly: supports TMFMSEntryForwarder (EIP-2771 calldata suffix).
 * - Mock APY: accrue() adds dripPerBlock * blocks to totalAssets (testnet).
 * - Adds future-proof storage for unstake queue, validator/liquidity modules, etc.
 */

import {Initializable} from "@ozu/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@ozu/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@ozu/contracts/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@ozu/contracts/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@ozu/contracts/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20}   from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IAquaMON {
    function mintShares(address to, uint256 shares) external;   // onlyCore in token
    function burnShares(address from, uint256 shares) external; // onlyCore in token
    function sharesOf(address user) external view returns (uint256);
}

contract StakePoolCore is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    // ========= Storage (v1) =========
    IERC20   public underlying;           // MON (or mock)
    IAquaMON public aqua;                 // AquaMON (rebasing)
    address  public trustedForwarder;     // EntryForwarder (EIP-2771)

    uint256 private _totalAssets;         // liabilities to depositors (gross of pending fees)
    uint256 private _totalShares;         // total user shares (source of truth)
    uint256 private _index;               // 1e18 scale; = assets * 1e18 / shares
    uint256 private _lastAccrualBlock;    // last block accrued

    // Mock yield + fees
    uint256 public dripPerBlock;          // testnet yield in asset units / block
    uint16  public feeMgmtBps;            // mgmt fee (bps) applied on accrual delta
    address public feeReceiver;           // fee sink
    uint256 public pendingFees;           // accrued (unskimmmed) fees in assets

    // Limits/config
    uint256 public maxDeposit_;           // 0 = unlimited
    uint256 public maxMint_;              // 0 = unlimited
    bool    public gaslessEnabled;        // feature-flag gate for meta-tx if needed

    // ========= NEW storage (v1.1 Spec parity / future-proof) =========
    uint16  public feePerfBps;            // performance fee bps (kept 0 for now)

    address public arc;                   // ArcMON (non-rebasing governance wrapper)
    address public validatorRegistry;     // future module
    address public liquidityModule;       // future instant-unstake module
    address public relayManager;          // optional (if core ever needs direct reads)
    address[] public safetyOracles;       // optional bounds/oracle checks

    // Delayed-unstake (placeholders; logic to be added in v1.2)
    struct UnstakeTicket {
        address owner;
        uint256 shares;
        uint256 assetsQuoted;
        uint64  claimableAt;
        bool    claimed;
    }
    mapping(uint256 => UnstakeTicket) public tickets;
    uint256 public nextTicketId;
    uint256 public unstakeCooldown;       // seconds
    uint256 public maxUnstakeQueue;
    bool    public instantUnstakeEnabled;

    // Storage gap (reduced from earlier to consume reserved slots safely)
    uint256[20] private __gap;

    // ========= Events =========
    event Deposited(address indexed user, uint256 assets, uint256 shares, address indexed to);
    event Withdrawn(address indexed user, uint256 shares, uint256 assets, address indexed to);
    event IndexUpdated(uint256 oldIndex, uint256 newIndex);
    event FeesSkimmed(address indexed to, uint256 assets);
    event ParamsUpdated(bytes32 key, uint256 oldVal, uint256 newVal);

    // ========= Errors =========
    error ZeroAmount();
    error ExceedsLimit();
    error InsufficientShares();
    error NotOwnerOfShares();
    error InvalidReceiver();
    error InvalidConfig();

    // ========= Initialize / Upgrade =========

    function initialize(
        address owner_,
        address underlying_,
        address aqua_,
        address forwarder_,
        uint256 dripPerBlock_
    ) external initializer {
        if (owner_ == address(0) || underlying_ == address(0) || aqua_ == address(0)) revert InvalidConfig();

        __Ownable_init(owner_);
        __UUPSUpgradeable_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        underlying       = IERC20(underlying_);
        aqua             = IAquaMON(aqua_);
        trustedForwarder = forwarder_;
        dripPerBlock     = dripPerBlock_;

        _index            = 1e18; // start at 1.0
        _lastAccrualBlock = block.number;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ========= Helpers (2771) =========

    function _msgSender2771() internal view returns (address s) {
        if (msg.sender == trustedForwarder && msg.data.length >= 20) {
            assembly { s := shr(96, calldataload(sub(calldatasize(), 20))) }
        } else {
            s = msg.sender;
        }
    }

    // ========= Views (Accounting) =========

    function totalAssets() public view returns (uint256) { return _totalAssets; }
    function totalShares() public view returns (uint256) { return _totalShares; }
    function index() public view returns (uint256) { return _index; }
    function lastAccrualBlock() public view returns (uint256) { return _lastAccrualBlock; }

    // ERC-4626-style conversions
    function convertToShares(uint256 assets) public view returns (uint256 shares) {
        if (assets == 0) return 0;
        return _totalShares == 0 ? assets : _mulDivUp(assets, 1e18, _index);
    }

    function convertToAssets(uint256 shares) public view returns (uint256 assetsOut) {
        if (shares == 0) return 0;
        return _mulDivDown(shares, _index, 1e18);
    }

    // max* views (compat)
    function maxDeposit(address) external view returns (uint256) {
        return maxDeposit_ == 0 ? type(uint256).max : maxDeposit_;
    }

    function maxMint(address) external view returns (uint256) {
        return maxMint_ == 0 ? type(uint256).max : maxMint_;
    }

    function maxRedeem(address owner_) external view returns (uint256) {
        return aqua.sharesOf(owner_);
    }

    function maxWithdraw(address owner_) external view returns (uint256) {
        return convertToAssets(aqua.sharesOf(owner_));
    }

    // ========= User Flows =========

    function deposit(uint256 assets, address to)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();
        if (to == address(0)) revert InvalidReceiver();
        _accrueInternal();

        if (maxDeposit_ != 0 && assets > maxDeposit_) revert ExceedsLimit();

        shares = convertToShares(assets);

        underlying.safeTransferFrom(_msgSender2771(), address(this), assets);

        _totalAssets += assets;
        mintSharesTo(to, shares); // internal wrapper updates _totalShares + Aqua

        _recomputeIndex();

        emit Deposited(_msgSender2771(), assets, shares, to);
    }

    function mint(uint256 shares, address to)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 assets)
    {
        if (shares == 0) revert ZeroAmount();
        if (to == address(0)) revert InvalidReceiver();
        _accrueInternal();

        if (maxMint_ != 0 && shares > maxMint_) revert ExceedsLimit();

        assets = _mulDivUp(shares, _index, 1e18);
        underlying.safeTransferFrom(_msgSender2771(), address(this), assets);

        _totalAssets += assets;
        mintSharesTo(to, shares);

        _recomputeIndex();

        emit Deposited(_msgSender2771(), assets, shares, to);
    }

    function redeem(uint256 shares, address to, address owner_)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 assets)
    {
        if (shares == 0) revert ZeroAmount();
        if (to == address(0)) revert InvalidReceiver();
        _accrueInternal();

        address sender = _msgSender2771();
        if (sender != owner_) revert NotOwnerOfShares();
        if (aqua.sharesOf(owner_) < shares) revert InsufficientShares();

        assets = convertToAssets(shares);

        burnSharesFrom(owner_, shares);
        _totalAssets -= assets;

        _recomputeIndex();

        underlying.safeTransfer(to, assets);

        emit Withdrawn(sender, shares, assets, to);
    }

    function withdraw(uint256 assets, address to, address owner_)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();
        if (to == address(0)) revert InvalidReceiver();
        _accrueInternal();

        address sender = _msgSender2771();
        if (sender != owner_) revert NotOwnerOfShares();

        shares = convertToShares(assets);
        if (aqua.sharesOf(owner_) < shares) revert InsufficientShares();

        burnSharesFrom(owner_, shares);
        _totalAssets -= assets;

        _recomputeIndex();

        underlying.safeTransfer(to, assets);

        emit Withdrawn(sender, shares, assets, to);
    }

    // ========= Accrual / Fees =========

    function accrue() external whenNotPaused returns (uint256 newIndex) {
        newIndex = _accrueInternal();
    }

    function _accrueInternal() internal returns (uint256 newIndex) {
        if (block.number == _lastAccrualBlock) return _index;

        uint256 blocks = block.number - _lastAccrualBlock;
        _lastAccrualBlock = block.number;

        if (dripPerBlock == 0) return _index;

        uint256 gross = dripPerBlock * blocks;
        if (gross == 0) return _index;

        // mgmt fee on gross accrual; perf fee placeholder (set to 0 unless you wire realized profit)
        uint256 fee = 0;
        if (feeMgmtBps != 0) fee += (gross * feeMgmtBps) / 10_000;
        // if (feePerfBps != 0) { /* apply on realized gains path later */ }

        _totalAssets += (gross - fee);
        if (fee > 0) pendingFees += fee;

        newIndex = _recomputeIndex();
    }

    function skimFees(uint256 amount) external whenNotPaused onlyOwner {
        if (feeReceiver == address(0)) revert InvalidReceiver();
        if (amount == 0 || amount > pendingFees) revert ZeroAmount();

        // Conservative buffer check
        uint256 bal = underlying.balanceOf(address(this));
        uint256 required = _totalAssets;
        require(bal >= required + amount - pendingFees, "insufficient buffer");

        pendingFees -= amount;
        underlying.safeTransfer(feeReceiver, amount);
        emit FeesSkimmed(feeReceiver, amount);
    }

    // ========= Admin / Params =========

    function setConfig(address aqua_, address forwarder_, uint256 dripPerBlock_) external onlyOwner {
        if (aqua_ == address(0)) revert InvalidConfig();
        address oldA = address(aqua);
        address oldF = trustedForwarder;
        uint256 oldD = dripPerBlock;

        aqua = IAquaMON(aqua_);
        trustedForwarder = forwarder_;
        dripPerBlock = dripPerBlock_;

        emit ParamsUpdated("aqua", uint256(uint160(oldA)), uint256(uint160(aqua_)));
        emit ParamsUpdated("forwarder", uint256(uint160(oldF)), uint256(uint160(forwarder_)));
        emit ParamsUpdated("dripPerBlock", oldD, dripPerBlock_);
    }

    function setArc(address arc_) external onlyOwner {
        address old = arc; arc = arc_;
        emit ParamsUpdated("arc", uint256(uint160(old)), uint256(uint160(arc_)));
    }

    function setFeeParams(uint16 mgmtBps, uint16 perfBps, address receiver) external onlyOwner {
        require(mgmtBps <= 2_000, "fee too high"); // ≤20%
        require(perfBps <= 2_000, "perf too high");
        uint256 oldM = feeMgmtBps; feeMgmtBps = mgmtBps; emit ParamsUpdated("feeMgmtBps", oldM, mgmtBps);
        uint256 oldP = feePerfBps; feePerfBps = perfBps; emit ParamsUpdated("feePerfBps", oldP, perfBps);
        address oldR = feeReceiver; feeReceiver = receiver; emit ParamsUpdated("feeReceiver", uint256(uint160(oldR)), uint256(uint160(receiver)));
    }

    function setLimits(uint256 maxDepositNew, uint256 maxMintNew) external onlyOwner {
        uint256 oldD = maxDeposit_; maxDeposit_ = maxDepositNew; emit ParamsUpdated("maxDeposit", oldD, maxDepositNew);
        uint256 oldM = maxMint_;    maxMint_    = maxMintNew;    emit ParamsUpdated("maxMint", oldM, maxMintNew);
    }

    function setGaslessEnabled(bool on) external onlyOwner {
        uint256 oldV = gaslessEnabled ? 1 : 0;
        gaslessEnabled = on;
        emit ParamsUpdated("gaslessEnabled", oldV, on ? 1 : 0);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ========= Internal primitives (spec-named) =========

    function mintSharesTo(address to, uint256 shares) internal {
        _totalShares += shares;
        aqua.mintShares(to, shares);
    }

    function burnSharesFrom(address from, uint256 shares) internal {
        _totalShares -= shares;
        aqua.burnShares(from, shares);
    }

    function _recomputeIndex() internal returns (uint256 newIndex) {
        uint256 old = _index;
        _index = (_totalShares == 0) ? 1e18 : (_totalAssets * 1e18) / _totalShares;
        if (_index != old) emit IndexUpdated(old, _index);
        return _index;
    }

    // ========= Utilities =========

    function recoverLostTokens(address token, address to, uint256 amount) external onlyOwner {
        // Do NOT allow pulling core assets or Aqua/Arc
        if (
            token == address(underlying) ||
            token == address(aqua) ||
            (arc != address(0) && token == arc)
        ) revert InvalidConfig();
        IERC20(token).safeTransfer(to, amount);
    }

    // mulDiv helpers
    function _mulDivDown(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        return (a * b) / d;
    }
    function _mulDivUp(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        return (a * b + d - 1) / d;
    }

    // ======== Convenience getters for UI discovery ========
    function aquaToken() external view returns (address) { return address(aqua); }
    function arcToken() external view returns (address) { return arc; }
}
