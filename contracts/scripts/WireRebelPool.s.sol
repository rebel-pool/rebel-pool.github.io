// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console2.sol";

interface ITMFMSRelayManager {
    function setForwarder(address fwd, bool ok) external;
    function setRelayer(address relayer, bool ok) external;
    function setAllowedMethod(address target, bytes4 selector, bool ok) external;
}

interface IEntryForwarder {
    function setRelayManager(address mgr) external;
    function setRelayer(address relayer, bool ok) external;
    function setAllowedTarget(address target, bool ok) external;
    function refreshDomainSeparator() external;
}

contract WireRebelPool is Script {
    address DEPLOYER_ADDR;
    uint256 DEPLOYER_PK;

    address RELAY_MANAGER_ADDRESS;
    address FORWARDER_ADDRESS;
    address RELAYER_ADDR;

    address STAKEPOOLCORE_ADDRESS;
    address AQUAMON_ADDRESS;
    address ARCMON_ADDRESS;

    function setUp() public {
        DEPLOYER_ADDR         = vm.envAddress("DEPLOYER_ADDR");
        DEPLOYER_PK           = vm.envUint("DEPLOYER_PK");

        RELAY_MANAGER_ADDRESS = vm.envAddress("RELAY_MANAGER_ADDRESS");
        FORWARDER_ADDRESS     = vm.envAddress("FORWARDER_ADDRESS");
        RELAYER_ADDR          = _tryEnvAddr("RELAYER_ADDR", address(0));

        STAKEPOOLCORE_ADDRESS = vm.envAddress("STAKEPOOLCORE_ADDRESS");
        AQUAMON_ADDRESS       = vm.envAddress("AQUAMON_ADDRESS");
        ARCMON_ADDRESS        = vm.envAddress("ARCMON_ADDRESS");
    }

    function run() public {
        vm.startBroadcast(DEPLOYER_PK);

        // 1) Wire forwarder <-> relay manager
        IEntryForwarder(FORWARDER_ADDRESS).setRelayManager(RELAY_MANAGER_ADDRESS);
        IEntryForwarder(FORWARDER_ADDRESS).refreshDomainSeparator();
        ITMFMSRelayManager(RELAY_MANAGER_ADDRESS).setForwarder(FORWARDER_ADDRESS, true);

        // 2) Allow relayer (if provided)
        if (RELAYER_ADDR != address(0)) {
            ITMFMSRelayManager(RELAY_MANAGER_ADDRESS).setRelayer(RELAYER_ADDR, true);
            IEntryForwarder(FORWARDER_ADDRESS).setRelayer(RELAYER_ADDR, true);
        }

        // 3) Allowlist pool + arcmon methods
        _allow(STAKEPOOLCORE_ADDRESS, "deposit(uint256,address)");
        _allow(STAKEPOOLCORE_ADDRESS, "withdraw(uint256,address,address)");
        _allow(STAKEPOOLCORE_ADDRESS, "redeem(uint256,address,address)");

        _allow(ARCMON_ADDRESS, "wrap(uint256,address)");
        _allow(ARCMON_ADDRESS, "unwrap(uint256,address)");

        // AquaMON usually uses permit; add meta methods later if needed

        vm.stopBroadcast();

        console2.log("== Rebel Pool Wiring ==");
        console2.log("RelayMgr   :", RELAY_MANAGER_ADDRESS);
        console2.log("Forwarder  :", FORWARDER_ADDRESS);
        if (RELAYER_ADDR != address(0)) console2.log("Relayer    :", RELAYER_ADDR);
        console2.log("Pool       :", STAKEPOOLCORE_ADDRESS);
        console2.log("AquaMON    :", AQUAMON_ADDRESS);
        console2.log("ArcMON     :", ARCMON_ADDRESS);
    }

    function _allow(address target, string memory sig) internal {
        bytes4 selector = bytes4(keccak256(bytes(sig)));
        IEntryForwarder(FORWARDER_ADDRESS).setAllowedTarget(target, true);
        ITMFMSRelayManager(RELAY_MANAGER_ADDRESS).setAllowedMethod(target, selector, true);
    }

    function _tryEnvAddr(string memory key, address fallbackAddr) internal returns (address v) {
        try vm.envAddress(key) returns (address x) { v = x; } catch { v = fallbackAddr; }
    }
}
