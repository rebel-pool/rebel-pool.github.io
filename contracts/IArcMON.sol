// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit}   from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IVotes}         from "@openzeppelin/contracts/governance/utils/IVotes.sol";


/// @title IArcMON (wstMON) — Non-rebasing governance wrapper around AquaMON
/// @notice ERC-20 + EIP-2612 + ERC20Votes surface, plus wrap/unwrap helpers.
///         Balances are constant; all yield flows into exchangeRate().
interface IArcMON is IERC20Metadata, IERC20Permit, IVotes {
    // ===== Core views =====
    function pool() external view returns (address);        // StakePoolCore
    function aqua() external view returns (address);        // AquaMON
    function exchangeRate() external view returns (uint256);// = pool.index() (1e18)

    // ===== Conversions =====
    function convertToArc(uint256 aquaAmount) external view returns (uint256 arcOut);
    function convertToAqua(uint256 arcAmount) external view returns (uint256 aquaOut);

    // ===== Core UX =====
    function wrap(uint256 aquaAmount, address to) external returns (uint256 arcOut);
    function unwrap(uint256 arcAmount, address to) external returns (uint256 aquaOut);
    function wrapWithPermit(
        uint256 aquaAmount,
        address to,
        uint256 value,
        uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external returns (uint256 arcOut);

    // ===== Events =====
    event Wrapped(address indexed user, uint256 aquaIn, uint256 arcOut);
    event Unwrapped(address indexed user, uint256 arcIn, uint256 aquaOut);
}
