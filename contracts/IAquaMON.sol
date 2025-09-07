// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit}   from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";


/// @title IAquaMON (stMON) — Rebasing ERC20 over internal shares (Upgradeable)
/// @notice Inherits ERC-20 & EIP-2612 *interfaces* for standards compliance (upgradeable variants).
///         IMPORTANT: All ERC-20 amounts (balanceOf/transfer/allowance/permit) are **rebased units**,
///         derived from internal shares via StakePoolCore.index() (1e18 scale).
interface IAquaMON is IERC20Metadata, IERC20Permit {
    // ======== Core relationships / views ========
    function pool() external view returns (address);
    /// @notice Pass-through to StakePoolCore.index() (1e18 scale)
    function poolIndex() external view returns (uint256);

    // ======== Shares accounting (internal units) ========
    function sharesOf(address account) external view returns (uint256);
    function totalShares() external view returns (uint256);

    // ======== Conversions (index-based) ========
    /// @notice external (rebased) -> shares (ceil)
    function convertToShares(uint256 externalAmt) external view returns (uint256 shares);
    /// @notice shares -> external (rebased) (floor)
    function convertToExternal(uint256 shares) external view returns (uint256 externalAmt);

    // ======== Core-only hooks (must restrict to StakePoolCore in implementation) ========
    function mintShares(address to, uint256 shares) external;
    function burnShares(address from, uint256 shares) external;
    /// @notice Optional: called by Core to emit Rebased & refresh cache; balances rebase implicitly on reads
    function onIndexUpdated(uint256 newIndex) external;
    /// @notice Anyone may sync cache from pool for analytics (optional)
    function sync() external returns (uint256 newIndex);

    // ======== AquaMON-specific events ========
    /// @notice Emitted when the observed pool index changes (for UI/indexers). Amounts don’t change storage.
    event Rebased(uint256 newIndex);
    /// @notice Share mints/burns (internal units) performed by Core.
    event MintShares(address indexed to, uint256 shares);
    event BurnShares(address indexed from, uint256 shares);
}
