// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console2.sol";

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {WMONUpgradeable} from "../src/the_rebel_pool/WMONUpgradeable.sol";
import {AquaMON} from "../src/the_rebel_pool/AquaMON.sol";
import {ArcMON} from "../src/the_rebel_pool/ArcMON.sol";
import {StakePoolCore} from "../src/the_rebel_pool/StakePoolCore.sol";
import {GaslessRouter} from "../src/the_rebel_pool/GaslessRouter.sol";

contract DeployRebelPool is Script {
    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        address deployer   = vm.addr(deployerPk);
        address forwarder  = vm.envAddress("FORWARDER_ADDRESS");
        uint256 dripPerBlock = vm.envOr("DRIP_PER_BLOCK", uint256(1e15)); // default 0.001 MON/block

        vm.startBroadcast(deployerPk);

        // -----------------------
        // WMON
        // -----------------------
        WMONUpgradeable wmonImpl = new WMONUpgradeable();
        ERC1967Proxy wmonProxy = new ERC1967Proxy(
            address(wmonImpl),
            abi.encodeWithSelector(WMONUpgradeable.initialize.selector, deployer)
        );
        WMONUpgradeable wmon = WMONUpgradeable(payable(address(wmonProxy)));

        // -----------------------
        // AquaMON
        // -----------------------
        AquaMON aquaImpl = new AquaMON();
        ERC1967Proxy aquaProxy = new ERC1967Proxy(
            address(aquaImpl),
            abi.encodeWithSelector(AquaMON.initialize.selector, "AquaMON", "stMON", deployer)
        );
        AquaMON aqua = AquaMON(address(aquaProxy));

        // -----------------------
        // StakePoolCore
        // -----------------------
        StakePoolCore poolImpl = new StakePoolCore();
        ERC1967Proxy poolProxy = new ERC1967Proxy(
            address(poolImpl),
            abi.encodeWithSelector(
                StakePoolCore.initialize.selector,
                deployer,
                address(wmon),
                address(aqua),
                forwarder,
                dripPerBlock
            )
        );
        StakePoolCore pool = StakePoolCore(address(poolProxy));

        // Wire Aqua <-> Pool
        aqua.setPool(address(pool));

        // -----------------------
        // ArcMON
        // -----------------------
        ArcMON arcImpl = new ArcMON();
        ERC1967Proxy arcProxy = new ERC1967Proxy(
            address(arcImpl),
            abi.encodeWithSelector(
                ArcMON.initialize.selector,
                "ArcMON",
                "wstMON",
                address(pool),
                address(aqua),
                deployer
            )
        );
        ArcMON arc = ArcMON(address(arcProxy));

        // Wire Arc into Pool
        pool.setArc(address(arc));

        // -----------------------
        // GaslessRouter
        // -----------------------
        GaslessRouter routerImpl = new GaslessRouter();
        ERC1967Proxy routerProxy = new ERC1967Proxy(
            address(routerImpl),
            abi.encodeWithSelector(
                GaslessRouter.initialize.selector,
                deployer,
                forwarder,
                address(wmon),
                address(pool),
                address(aqua),
                address(arc)
            )
        );
        GaslessRouter router = GaslessRouter(address(routerProxy));

        vm.stopBroadcast();

        // -----------------------
        // Logs
        // -----------------------
        console2.log("== Rebel Pool Deployment ==");
        console2.log("Deployer    :", deployer);
        console2.log("WMON_PROXY  :", address(wmon));
        console2.log("WMON_IMPL   :", address(wmonImpl));
        console2.log("AQUA_PROXY  :", address(aqua));
        console2.log("AQUA_IMPL   :", address(aquaImpl));
        console2.log("POOL_PROXY  :", address(pool));
        console2.log("POOL_IMPL   :", address(poolImpl));
        console2.log("ARCMON_PROXY:", address(arc));
        console2.log("ARCMON_IMPL :", address(arcImpl));
        console2.log("ROUTER_PROXY:", address(router));
        console2.log("ROUTER_IMPL :", address(routerImpl));
    }
}
