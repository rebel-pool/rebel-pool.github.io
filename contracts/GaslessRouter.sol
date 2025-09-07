// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * GaslessRouter — bundles EIP-2612 permits with protocol actions.
 * - Called via TMFMSEntryForwarder (EIP-2771). We recover end-user with _msgSender2771().
 * - stakeWithPermit:  underlying.permit -> pull to router -> approve core -> core.deposit(assets,to)
 * - wrapWithPermit:   aqua.permit       -> pull to router -> approve arc  -> arc.wrap(aqua,to)
 * - unwrapWithPermit: arc.permit        -> pull to router ->               arc.unwrap(arc,to)
 * 
 * Notes:
 * - Core.deposit will see msg.sender = Router (not Forwarder), so it pulls from Router (we approve).
 * - Events include the *user* recovered via 2771 for off-chain attribution.
 */

import {Initializable}              from "@ozu/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable}            from "@ozu/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable}         from "@ozu/contracts/access/OwnableUpgradeable.sol";
import {PausableUpgradeable}        from "@ozu/contracts/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@ozu/contracts/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20}      from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20}    from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// --- minimal interfaces used (kept tiny to avoid path coupling) ---

interface IStakePoolCore {
    function deposit(uint256 assets, address to) external returns (uint256 shares);
    function index() external view returns (uint256);
}

interface IAquaMON is IERC20, IERC20Permit {}

interface IArcMON is IERC20, IERC20Permit {
    function wrap(uint256 aquaAmount, address to) external returns (uint256 arcOut);
    function unwrap(uint256 arcAmount, address to) external returns (uint256 aquaOut);
}

contract GaslessRouter is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;
    using SafeERC20 for IAquaMON;
    using SafeERC20 for IArcMON;

    // --- storage ---
    address public trustedForwarder; // TMFMSEntryForwarder
    IERC20  public underlying;       // MON (must support permit for stakeWithPermit UX)
    IStakePoolCore public core;      // StakePoolCore
    IAquaMON public aqua;            // AquaMON (rebasing)
    IArcMON  public arc;             // ArcMON (non-rebasing)

    // --- events for indexers ---
    event GaslessStake(address indexed user, address indexed to, uint256 assets, uint256 shares);
    event GaslessWrap(address indexed user, address indexed to, uint256 aquaIn, uint256 arcOut);
    event GaslessUnwrap(address indexed user, address indexed to, uint256 arcIn, uint256 aquaOut);
    event ParamsUpdated(bytes32 key, address oldAddr, address newAddr);

    // --- errors ---
    error ZeroAddress();
    error ZeroAmount();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(
        address owner_,
        address trustedForwarder_,
        address underlying_,
        address core_,
        address aqua_,
        address arc_
    ) external initializer {
        if (owner_ == address(0) || trustedForwarder_ == address(0) || underlying_ == address(0) ||
            core_ == address(0) || aqua_ == address(0) || arc_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);
        __UUPSUpgradeable_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        trustedForwarder = trustedForwarder_;
        underlying = IERC20(underlying_);
        core = IStakePoolCore(core_);
        aqua = IAquaMON(aqua_);
        arc = IArcMON(arc_);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // --- EIP-2771 helper ---
    function _msgSender2771() internal view returns (address s) {
        if (msg.sender == trustedForwarder && msg.data.length >= 20) {
            assembly { s := shr(96, calldataload(sub(calldatasize(), 20))) }
        } else {
            s = msg.sender;
        }
    }

    // --- admin ---
    function setTrustedForwarder(address fwd) external onlyOwner {
        if (fwd == address(0)) revert ZeroAddress();
        address old = trustedForwarder; trustedForwarder = fwd;
        emit ParamsUpdated("forwarder", old, fwd);
    }

    function setAddresses(address underlying_, address core_, address aqua_, address arc_) external onlyOwner {
        if (underlying_ == address(0) || core_ == address(0) || aqua_ == address(0) || arc_ == address(0)) revert ZeroAddress();
        address old;
        old = address(underlying); underlying = IERC20(underlying_); emit ParamsUpdated("underlying", old, underlying_);
        old = address(core);       core = IStakePoolCore(core_);     emit ParamsUpdated("core",       old, core_);
        old = address(aqua);       aqua = IAquaMON(aqua_);            emit ParamsUpdated("aqua",       old, aqua_);
        old = address(arc);        arc  = IArcMON(arc_);              emit ParamsUpdated("arc",        old, arc_);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ------------------------------------------------------------
    // GASLESS FLOWS (to be called via EntryForwarder)
    // ------------------------------------------------------------

    /// @notice Gasless stake using underlying's EIP-2612 permit.
    /// User signs a permit for this Router; Router pulls tokens and deposits into Core.
    function stakeWithPermit(
        uint256 assets,
        address to,
        uint256 value,
        uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external whenNotPaused nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        address user = _msgSender2771();

        // 1) underlying.permit(user -> router)
        IERC20Permit(address(underlying)).permit(user, address(this), value, deadline, v, r, s);

        // 2) pull to router, then approve core and deposit
        underlying.safeTransferFrom(user, address(this), assets);
        underlying.safeIncreaseAllowance(address(core), assets);
        shares = core.deposit(assets, to);

        emit GaslessStake(user, to, assets, shares);
    }

    /// @notice Gasless wrap using Aqua's EIP-2612 permit.
    /// User signs permit for Router; Router pulls Aqua, approves Arc, then calls Arc.wrap.
    function wrapWithPermit(
        uint256 aquaAmount,
        address to,
        uint256 value,
        uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external whenNotPaused nonReentrant returns (uint256 arcOut) {
        if (aquaAmount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        address user = _msgSender2771();

        // 1) aqua.permit(user -> router)
        aqua.permit(user, address(this), value, deadline, v, r, s);

        // 2) pull Aqua to router
        aqua.safeTransferFrom(user, address(this), aquaAmount);

        // 3) approve Arc to spend router's Aqua; call wrap (Arc pulls from router)
        aqua.safeIncreaseAllowance(address(arc), aquaAmount);
        arcOut = arc.wrap(aquaAmount, to);

        emit GaslessWrap(user, to, aquaAmount, arcOut);
    }

    /// @notice Gasless unwrap using Arc's EIP-2612 permit.
    /// User signs permit for Router; Router pulls Arc to itself and calls Arc.unwrap (burns router's Arc).
    function unwrapWithPermit(
        uint256 arcAmount,
        address to,
        uint256 value,
        uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external whenNotPaused nonReentrant returns (uint256 aquaOut) {
        if (arcAmount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        address user = _msgSender2771();

        // 1) arc.permit(user -> router)
        arc.permit(user, address(this), value, deadline, v, r, s);

        // 2) pull Arc to router; unwrap (burns router's Arc balance)
        arc.safeTransferFrom(user, address(this), arcAmount);
        aquaOut = arc.unwrap(arcAmount, to);

        emit GaslessUnwrap(user, to, arcAmount, aquaOut);
    }

    // ------------------------------------------------------------
    // Views (helpers)
    // ------------------------------------------------------------
    function exchangeRate() external view returns (uint256) {
        return core.index();
    }
}
