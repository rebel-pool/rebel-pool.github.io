// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * ArcMON (wstMON) — Non-rebasing wrapper around AquaMON (stMON)
 * - Fixed balances; growth expressed via exchangeRate() that mirrors StakePoolCore.index() (1e18).
 * - Custodial wrapping (like wstETH): contract holds Aqua; mints/burns Arc.
 * - Upgradeable (UUPS), Ownable, Pausable (wrap/unwrap gated), ReentrancyGuard.
 * - ERC20Votes for governance (voting power == Arc balance).
 * - EIP-2612 permit on Arc itself + wrapWithPermit for Aqua.
 */

import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {Initializable}              from "@ozu/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable}            from "@ozu/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable}         from "@ozu/contracts/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@ozu/contracts/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable}        from "@ozu/contracts/utils/PausableUpgradeable.sol";
import {ERC20Upgradeable}           from "@ozu/contracts/token/ERC20/ERC20Upgradeable.sol";
import {ERC20PermitUpgradeable}     from "@ozu/contracts/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {ERC20VotesUpgradeable}      from "@ozu/contracts/token/ERC20/extensions/ERC20VotesUpgradeable.sol";
import {NoncesUpgradeable} from "@ozu/contracts/utils/NoncesUpgradeable.sol";

import {SafeERC20}                  from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20}                     from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IAquaMON}                   from "./IAquaMON.sol";
import {IArcMON}                    from "./IArcMON.sol";

interface IStakePoolCoreIndex { function index() external view returns (uint256); }

contract ArcMON is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    ERC20VotesUpgradeable,
    IArcMON
{
    using SafeERC20 for IERC20;
    using SafeERC20 for IAquaMON;

    // --- Errors ---
    error ZeroAmount();
    error InvalidAddress();

    // --- Storage ---
    address private _pool; // StakePoolCore
    address private _aqua; // AquaMON (rebasing)

    // --- Events (from IArcMON) ---
    // event Wrapped(address indexed user, uint256 aquaIn, uint256 arcOut);
    // event Unwrapped(address indexed user, uint256 arcIn, uint256 aquaOut);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(
        string memory name_,
        string memory symbol_,
        address pool_,
        address aqua_,
        address owner_
    ) external initializer {
        if (pool_ == address(0) || aqua_ == address(0) || owner_ == address(0)) revert InvalidAddress();

        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __ERC20Votes_init();
        __Ownable_init(owner_);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();

        _pool = pool_;
        _aqua = aqua_;
    }

    // --- UUPS auth ---
    function _authorizeUpgrade(address) internal override onlyOwner {}

    // --- Views (IArcMON) ---
    function pool() public view override returns (address) { return _pool; }
    function aqua() public view override returns (address) { return _aqua; }

    /// @notice 1e18-scaled, equals StakePoolCore.index()
    function exchangeRate() public view override returns (uint256) {
        return IStakePoolCoreIndex(_pool).index();
    }

    function convertToArc(uint256 aquaAmount) public view override returns (uint256 arcOut) {
        uint256 rate = exchangeRate(); // 1e18
        require(rate > 0, "rate=0");
        unchecked { arcOut = (aquaAmount * 1e18) / rate; } // floor
    }

    function convertToAqua(uint256 arcAmount) public view override returns (uint256 aquaOut) {
        uint256 rate = exchangeRate();
        require(rate > 0, "rate=0");
        unchecked { aquaOut = (arcAmount * rate) / 1e18; } // floor
    }

    // --- Core UX (IArcMON) ---
    function wrap(uint256 aquaAmount, address to)
        public
        override
        whenNotPaused
        nonReentrant
        returns (uint256 arcOut)
    {
        if (aquaAmount == 0) revert ZeroAmount();
        if (to == address(0)) revert InvalidAddress();

        arcOut = convertToArc(aquaAmount);
        require(arcOut > 0, "dust");

        // Pull Aqua into wrapper (custodial)
        IAquaMON(_aqua).safeTransferFrom(msg.sender, address(this), aquaAmount);

        _mint(to, arcOut);
        emit Wrapped(msg.sender, aquaAmount, arcOut);
    }

    /// @notice wrap using Aqua's EIP-2612 permit in one tx
    function wrapWithPermit(
        uint256 aquaAmount,
        address to,
        uint256 value,
        uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external override returns (uint256 arcOut) {
        IAquaMON(_aqua).permit(msg.sender, address(this), value, deadline, v, r, s);
        arcOut = wrap(aquaAmount, to);
    }

    function unwrap(uint256 arcAmount, address to)
        external
        override
        whenNotPaused
        nonReentrant
        returns (uint256 aquaOut)
    {
        if (arcAmount == 0) revert ZeroAmount();
        if (to == address(0)) revert InvalidAddress();

        aquaOut = convertToAqua(arcAmount);
        _burn(msg.sender, arcAmount);
        IERC20(_aqua).safeTransfer(to, aquaOut);

        emit Unwrapped(msg.sender, arcAmount, aquaOut);
    }

    // --- Admin ---
    function setPause(bool on) external onlyOwner { if (on) _pause(); else _unpause(); }

    function setPool(address pool_) external onlyOwner {
        if (pool_ == address(0)) revert InvalidAddress();
        _pool = pool_;
    }

    function setAqua(address aqua_) external onlyOwner {
        if (aqua_ == address(0)) revert InvalidAddress();
        _aqua = aqua_;
    }

    /// @notice Rescue non-core tokens accidentally sent; cannot pull Aqua or Arc itself.
    function recoverLostTokens(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidAddress();
        require(token != address(0) && token != _aqua && token != address(this), "blacklisted");
        IERC20(token).safeTransfer(to, amount);
    }

    // --- OZ overrides (Votes) ---
    function _update(address from, address to, uint256 value)
        internal
        override(ERC20Upgradeable, ERC20VotesUpgradeable)
    {
        super._update(from, to, value);
    }

    function nonces(address owner)
        public
        view
        override(ERC20PermitUpgradeable, NoncesUpgradeable, IERC20Permit)
        returns (uint256)
    {
        return super.nonces(owner);
    }


}
