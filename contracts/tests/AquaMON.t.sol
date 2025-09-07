// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/the_rebel_pool/AquaMON.sol";
import {StakePoolCore} from "../src/the_rebel_pool/StakePoolCore.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract AquaMONTest is Test {
    AquaMON aqua;
    StakePoolCore core;
    MockERC20 underlying;
    address owner;
    address coreAddr;
    address alice = address(0x1);
    address bob = address(0x2);

    function setUp() public {
        owner = address(this);
        underlying = new MockERC20("TestMON", "MON", 18);
        core = new StakePoolCore();
        coreAddr = address(core);
        aqua = new AquaMON();

        // Standard initialize
        aqua.initialize("AquaMON", "stMON", coreAddr);

        // Simulate pool/owner setup
        vm.label(owner, "Owner");
        vm.label(alice, "Alice");
        vm.label(bob, "Bob");
    }

    function test_metadata() public {
        assertEq(aqua.name(), "AquaMON");
        assertEq(aqua.symbol(), "stMON");
        assertEq(aqua.decimals(), 18);
        assertEq(aqua.pool(), coreAddr);
    }

    function test_mintShares_and_burnShares() public {
        // Only pool/core can call
        vm.expectRevert("onlyCore");
        aqua.mintShares(alice, 1e18);

        // Call as pool (prank)
        vm.prank(coreAddr);
        aqua.mintShares(alice, 1e18);
        assertEq(aqua.balanceOf(alice), 1e18);
        assertEq(aqua.totalSupply(), 1e18);

        // Burn shares
        vm.prank(coreAddr);
        aqua.burnShares(alice, 1e18);
        assertEq(aqua.balanceOf(alice), 0);
        assertEq(aqua.totalSupply(), 0);
    }

    function test_sharesOf() public {
        vm.prank(coreAddr);
        aqua.mintShares(alice, 5e17);
        assertEq(aqua.sharesOf(alice), 5e17);
    }

    function test_transfer_blocked_directly() public {
        vm.prank(coreAddr);
        aqua.mintShares(alice, 1e18);

        vm.prank(alice);
        vm.expectRevert("Aqua: transfer disabled");
        aqua.transfer(bob, 1e18);

        vm.prank(alice);
        vm.expectRevert("Aqua: transfer disabled");
        aqua.approve(bob, 1e18);

        vm.prank(bob);
        vm.expectRevert("Aqua: transfer disabled");
        aqua.transferFrom(alice, bob, 1e18);
    }

    function test_permit_EIP2612() public {
        // Set up a valid permit using test helper
        uint256 privateKey = 0xA11CE; // random key for Alice
        address aliceAddr = vm.addr(privateKey);

        // Mint shares to Alice for test
        vm.prank(coreAddr);
        aqua.mintShares(aliceAddr, 1e18);

        // Prepare permit
        uint256 nonce = aqua.nonces(aliceAddr);
        uint256 deadline = block.timestamp + 3600;
        bytes32 digest = _getPermitDigest(
            address(aqua), aliceAddr, bob, 1e18, nonce, deadline
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);

        // Execute permit
        vm.prank(bob);
        aqua.permit(aliceAddr, bob, 1e18, deadline, v, r, s);
        assertEq(aqua.nonces(aliceAddr), 1);
        // Approval is valid (but transfer will still revert due to transfer restriction)
    }

    function _getPermitDigest(
        address token,
        address owner_,
        address spender_,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        // Emulate EIP-2612 digest (grab DOMAIN_SEPARATOR)
        bytes32 DOMAIN_SEPARATOR = aqua.DOMAIN_SEPARATOR();
        bytes32 PERMIT_TYPEHASH = keccak256(
            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
        );
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(
                    abi.encode(
                        PERMIT_TYPEHASH,
                        owner_,
                        spender_,
                        value,
                        nonce,
                        deadline
                    )
                )
            )
        );
    }

    function test_onlyCore_reverts() public {
        // Confirm reverts for non-core
        vm.expectRevert("onlyCore");
        aqua.burnShares(alice, 1e18);

        vm.expectRevert("onlyCore");
        aqua.mintShares(alice, 1e18);
    }


    // --- Commented placeholders for future/v2 hooks ---
    // function test_rewardHandler() public {
    //     // Placeholder for future reward module
    // }
}

