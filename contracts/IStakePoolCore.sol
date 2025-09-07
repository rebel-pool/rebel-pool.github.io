// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IStakePoolCore
/// @notice ERC-4626-like interface for the Monad Fantastic Liquid Staking Pool (core)
interface IStakePoolCore {
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

    // ========= Core views =========
    function underlying() external view returns (address);
    function aqua() external view returns (address);
    function arc() external view returns (address);
    function trustedForwarder() external view returns (address);

    function totalAssets() external view returns (uint256);
    function totalShares() external view returns (uint256);
    function index() external view returns (uint256);
    function lastAccrualBlock() external view returns (uint256);

    // Params / fees / limits
    function dripPerBlock() external view returns (uint256);
    function feeMgmtBps() external view returns (uint16);
    function feePerfBps() external view returns (uint16);
    function feeReceiver() external view returns (address);
    function pendingFees() external view returns (uint256);

    function maxDeposit_() external view returns (uint256);
    function maxMint_() external view returns (uint256);
    function gaslessEnabled() external view returns (bool);

    // Future modules / discovery
    function validatorRegistry() external view returns (address);
    function liquidityModule() external view returns (address);
    function relayManager() external view returns (address);
    function safetyOracles(uint256 idx) external view returns (address);

    // Delayed-unstake (placeholders)
    function nextTicketId() external view returns (uint256);
    function unstakeCooldown() external view returns (uint256);
    function maxUnstakeQueue() external view returns (uint256);
    function instantUnstakeEnabled() external view returns (bool);

    // Convenience getters
    function aquaToken() external view returns (address);
    function arcToken() external view returns (address);

    // ========= Conversions (ERC-4626-style) =========
    function convertToShares(uint256 assets) external view returns (uint256 shares);
    function convertToAssets(uint256 shares) external view returns (uint256 assetsOut);

    function previewDeposit(uint256 assets) external view returns (uint256 shares);
    function previewMint(uint256 shares) external view returns (uint256 assets);
    function previewWithdraw(uint256 assets) external view returns (uint256 shares);
    function previewRedeem(uint256 shares) external view returns (uint256 assets);

    function maxDeposit(address) external view returns (uint256);
    function maxMint(address) external view returns (uint256);
    function maxRedeem(address owner_) external view returns (uint256);
    function maxWithdraw(address owner_) external view returns (uint256);

    // ========= User flows =========
    function deposit(uint256 assets, address to) external returns (uint256 shares);
    function mint(uint256 shares, address to) external returns (uint256 assets);
    function redeem(uint256 shares, address to, address owner_) external returns (uint256 assets);
    function withdraw(uint256 assets, address to, address owner_) external returns (uint256 shares);

    // ========= Accrual / Fees =========
    function accrue() external returns (uint256 newIndex);
    function skimFees(uint256 amount) external;

    // ========= Admin / Params =========
    function setConfig(address aqua_, address forwarder_, uint256 dripPerBlock_) external;
    function setArc(address arc_) external;
    function setFeeParams(uint16 mgmtBps, uint16 perfBps, address receiver) external;
    function setLimits(uint256 maxDepositNew, uint256 maxMintNew) external;
    function setGaslessEnabled(bool on) external;

    function pause() external;
    function unpause() external;

    // Safety
    function recoverLostTokens(address token, address to, uint256 amount) external;
}
