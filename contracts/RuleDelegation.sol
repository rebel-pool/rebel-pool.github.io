// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * RuleDelegation — Delegated Rule-Based Staking Assistant
 * --------------------------------------------------------
 * Users register automation rules (auto-compound, DCA, validator switch, etc).
 * Any executor may trigger rules when conditions are met. Executors earn micro-tip.
 *
 * - Gasless ready (EIP-2771 trusted forwarder).
 * - Integrates with StakePoolCore / AquaMON / ArcMON.
 * - Deterministic, no backend required.
 *
 * Rule Types:
 * 1 = Auto-Compound
 * 2 = Unstake
 * 3 = Delegate Stake
 * 4 = Partial Stop-Loss / Take Profit
 * 5 = Harvest & Convert (via Router)
 * 6 = Yield Rebalance (switch validator/strategy)
 * 7 = Suggestion (emit event only, no funds move)
 */

import {Initializable} from "@ozu/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@ozu/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@ozu/contracts/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@ozu/contracts/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@ozu/contracts/utils/PausableUpgradeable.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IStakePoolCore {
    function deposit(uint256 assets, address to) external returns (uint256 shares);
    function redeem(uint256 shares, address to, address owner) external returns (uint256 assets);
    function accrue() external returns (uint256 newIndex);
    function convertToShares(uint256 assets) external view returns (uint256 shares);
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
}

interface IAquaMON {
    function sharesOf(address user) external view returns (uint256);
    function balanceOf(address user) external view returns (uint256);
}

interface IStrategyRouter {
    function harvestAndConvert(address user, address targetToken, uint256 minOut) external;
    function rebalance(address user, address targetValidator, uint256 minDeltaBps) external;
}

contract RuleDelegation is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    // ========= Data Structures =========
    struct Rule {
        address owner;        // user who created the rule
        uint8 ruleType;       // 1–7 (see header)
        uint256 threshold;    // numeric condition (min yield, APY delta, % unstake, etc)
        address target;       // optional: delegate/validator/router/receiver
        uint256 rewardBps;    // micro-tip (basis points of action amount)
        bool active;          // rule enabled
    }

    // ========= Storage =========
    mapping(uint256 => Rule) public rules;
    uint256 public nextRuleId;

    IStakePoolCore public pool;
    IAquaMON public aqua;
    IERC20 public underlying; // MON or WMON
    address public trustedForwarder;
    address public strategyRouter; // external router for ruleType 5 & 6

    // ========= Events =========
    event RuleCreated(uint256 indexed ruleId, address indexed owner, uint8 ruleType, uint256 threshold);
    event RuleExecuted(uint256 indexed ruleId, address indexed executor, uint256 reward);
    event RuleDisabled(uint256 indexed ruleId, address indexed owner);
    event SuggestionEmitted(uint256 indexed ruleId, address indexed owner, string message);

    // ========= Init / Upgrade =========
    constructor() { _disableInitializers(); }

    function initialize(
        address pool_,
        address aqua_,
        address underlying_,
        address forwarder_,
        address owner_
    ) external initializer {
        require(pool_ != address(0) && aqua_ != address(0) && underlying_ != address(0), "bad addr");

        __Ownable_init(owner_);
        __UUPSUpgradeable_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        pool = IStakePoolCore(pool_);
        aqua = IAquaMON(aqua_);
        underlying = IERC20(underlying_);
        trustedForwarder = forwarder_;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ========= Admin =========
    function setStrategyRouter(address router) external onlyOwner {
        strategyRouter = router;
    }

    // ========= Meta-tx sender =========
    function _msgSender2771() internal view returns (address s) {
        if (msg.sender == trustedForwarder && msg.data.length >= 20) {
            assembly {
                s := shr(96, calldataload(sub(calldatasize(), 20)))
            }
        } else {
            s = msg.sender;
        }
    }

    // ========= Rule Lifecycle =========
    function createRule(uint8 ruleType, uint256 threshold, address target, uint256 rewardBps)
        external
        whenNotPaused
        returns (uint256 ruleId)
    {
        require(rewardBps <= 1000, "tip too high"); // ≤10%
        require(ruleType >= 1 && ruleType <= 7, "invalid type");

        ruleId = nextRuleId++;
        rules[ruleId] = Rule({
            owner: _msgSender2771(),
            ruleType: ruleType,
            threshold: threshold,
            target: target,
            rewardBps: rewardBps,
            active: true
        });

        emit RuleCreated(ruleId, _msgSender2771(), ruleType, threshold);
    }

    function disableRule(uint256 ruleId) external {
        Rule storage r = rules[ruleId];
        require(r.owner == _msgSender2771(), "not owner");
        r.active = false;
        emit RuleDisabled(ruleId, r.owner);
    }

    function enableRule(uint256 ruleId) external {
        Rule storage r = rules[ruleId];
        require(r.owner == _msgSender2771(), "not owner");
        r.active = true;
    }

    // ========= Execution =========
    function executeRule(uint256 ruleId) external nonReentrant whenNotPaused {
        Rule storage r = rules[ruleId];
        require(r.active, "inactive");

        address owner = r.owner;
        uint256 reward;

        if (r.ruleType == 1) {
            // Auto-Compound
            uint256 shares = aqua.sharesOf(owner);
            uint256 assets = pool.convertToAssets(shares);
            if (assets < r.threshold) revert("threshold not met");
            reward = (assets * r.rewardBps) / 10_000;
            if (reward > 0) underlying.safeTransferFrom(owner, msg.sender, reward);
            pool.accrue();

        } else if (r.ruleType == 2) {
            // Unstake full
            uint256 shares = aqua.sharesOf(owner);
            require(shares >= r.threshold, "unstake threshold not met");
            reward = (shares * r.rewardBps) / 10_000;
            if (reward > 0) underlying.safeTransferFrom(owner, msg.sender, reward);
            pool.redeem(shares, r.target != address(0) ? r.target : owner, owner);

        } else if (r.ruleType == 3) {
            // Delegate stake (move stake)
            require(r.target != address(0), "no target");
            uint256 amt = r.threshold;
            reward = (amt * r.rewardBps) / 10_000;
            if (reward > 0) underlying.safeTransferFrom(owner, msg.sender, reward);
            underlying.safeTransferFrom(owner, address(this), amt);
            underlying.approve(address(pool), amt);
            pool.deposit(amt, r.target);

        } else if (r.ruleType == 4) {
            // Partial Stop-Loss / Take Profit
            uint256 shares = aqua.sharesOf(owner);
            require(shares > 0, "no shares");
            uint256 pct = r.threshold; // e.g. 2500 = 25.00%
            require(pct > 0 && pct <= 10_000, "bad percent");
            uint256 redeemShares = (shares * pct) / 10_000;
            reward = (redeemShares * r.rewardBps) / 10_000;
            if (reward > 0) underlying.safeTransferFrom(owner, msg.sender, reward);
            pool.redeem(redeemShares, r.target != address(0) ? r.target : owner, owner);

        } else if (r.ruleType == 5) {
            // Harvest & Convert (via StrategyRouter)
            require(strategyRouter != address(0), "no router");
            IStrategyRouter(strategyRouter).harvestAndConvert(owner, r.target, r.threshold);
            reward = r.rewardBps; // flat basis points used as tip measure (can adjust)

        } else if (r.ruleType == 6) {
            // Yield Rebalance
            require(strategyRouter != address(0), "no router");
            IStrategyRouter(strategyRouter).rebalance(owner, r.target, r.threshold);
            reward = r.rewardBps;

        } else if (r.ruleType == 7) {
            // Suggestion only
            emit SuggestionEmitted(ruleId, owner, "Nudge: Review strategy for better yield");
            reward = 0;

        } else {
            revert("unknown type");
        }

        emit RuleExecuted(ruleId, msg.sender, reward);
    }
}
