// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * WMON (Wrapped MON) — Upgradeable, ERC20 + Permit, WETH-like
 * - deposit() / receive(): wrap native MON -> mint WMON 1:1
 * - withdraw/withdrawTo(): burn WMON -> send MON
 * - EIP-2612 for gasless approvals (used by GaslessRouter.stakeWithPermit)
 */

import {Initializable}              from "@ozu/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable}            from "@ozu/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable}         from "@ozu/contracts/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@ozu/contracts/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable}        from "@ozu/contracts/utils/PausableUpgradeable.sol";
import {ERC20Upgradeable}           from "@ozu/contracts/token/ERC20/ERC20Upgradeable.sol";
import {ERC20PermitUpgradeable}     from "@ozu/contracts/token/ERC20/extensions/ERC20PermitUpgradeable.sol";

contract WMONUpgradeable is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable
{
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(address owner_) external initializer {
        __Ownable_init(owner_);
        __UUPSUpgradeable_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __ERC20_init("Wrapped MON", "WMON");
        __ERC20Permit_init("Wrapped MON");
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    receive() external payable { _deposit(msg.sender); }

    function deposit() external payable whenNotPaused { _deposit(msg.sender); }

    function depositTo(address to) external payable whenNotPaused {
        require(to != address(0), "to=0");
        _deposit(to);
    }

    function withdraw(uint256 amount) external whenNotPaused nonReentrant {
        _withdrawTo(msg.sender, amount);
    }

    function withdrawTo(address to, uint256 amount) external whenNotPaused nonReentrant {
        require(to != address(0), "to=0");
        _withdrawTo(to, amount);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ---- internals ----
    function _deposit(address to) internal {
        require(msg.value > 0, "no value");
        _mint(to, msg.value);
        // no event beyond Transfer; ERC20 emits it
    }

    function _withdrawTo(address to, uint256 amount) internal {
        require(amount > 0, "zero amt");
        _burn(msg.sender, amount);
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "mon send fail");
        // ERC20 Transfer(from->0) already emitted by _burn
    }
}
