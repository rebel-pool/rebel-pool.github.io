// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console2.sol";

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {RuleDelegation} from "../src/the_rebel_pool/RuleDelegation.sol";

interface IEntryForwarder {
    function setAllowedTarget(address target, bool ok) external;
    function refreshDomainSeparator() external;
}

interface ITMFMSRelayManager {
    function setAllowedMethod(address target, bytes4 selector, bool ok) external;
}

contract DeployRuleDelegation is Script {
    // --- Env vars ---
    address deployerAddr;
    uint256 deployerPk;

    address poolProxyAddr;
    address aquaProxyAddr;
    address underlyingAddr;   // WMON proxy
    address forwarderAddr;
    address relayMgrAddr;
    address strategyRouterAddr; // NEW

    RuleDelegation public ruleDelegation;

    function setUp() public {
        deployerAddr       = vm.envAddress("DEPLOYER_ADDR");
        deployerPk         = vm.envUint("DEPLOYER_PK");

        poolProxyAddr      = vm.envAddress("POOL_PROXY_ADDRESS");
        aquaProxyAddr      = vm.envAddress("AQUA_PROXY_ADDRESS");
        underlyingAddr     = vm.envAddress("WMON_PROXY_ADDRESS");
        forwarderAddr      = vm.envAddress("FORWARDER_ADDRESS");
        relayMgrAddr       = vm.envAddress("RELAY_MANAGER_ADDRESS");

        // optional, if not set => address(0)
        if (vm.envExists("STRATEGY_ROUTER_ADDRESS")) {
            strategyRouterAddr = vm.envAddress("STRATEGY_ROUTER_ADDRESS");
        }
    }

    function run() public {
        vm.startBroadcast(deployerPk);

        // 1) Deploy implementation
        RuleDelegation impl = new RuleDelegation();

        // 2) Prepare init data for proxy
        bytes memory initData = abi.encodeWithSelector(
            RuleDelegation.initialize.selector,
            poolProxyAddr,
            aquaProxyAddr,
            underlyingAddr,
            forwarderAddr,
            deployerAddr
        );

        // 3) Deploy proxy pointing to implementation
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);

        // 4) Wrap proxy in RuleDelegation type
        ruleDelegation = RuleDelegation(address(proxy));

        console2.log("== RuleDelegation Deployed ==");
        console2.log("Implementation:", address(impl));
        console2.log("Proxy:", address(proxy));

        // 5) Wire with Forwarder + Relay Manager (meta-tx ready)
        IEntryForwarder(forwarderAddr).setAllowedTarget(address(ruleDelegation), true);
        IEntryForwarder(forwarderAddr).refreshDomainSeparator();

        _allow(address(ruleDelegation), "executeRule(uint256)");

        // 6) Set strategy router if provided
        if (strategyRouterAddr != address(0)) {
            ruleDelegation.setStrategyRouter(strategyRouterAddr);
            console2.log("StrategyRouter wired:", strategyRouterAddr);
        } else {
            console2.log("StrategyRouter not set (address(0))");
        }

        vm.stopBroadcast();
    }

    function _allow(address target, string memory sig) internal {
        bytes4 selector = bytes4(keccak256(bytes(sig)));
        ITMFMSRelayManager(relayMgrAddr).setAllowedMethod(target, selector, true);
    }
}
