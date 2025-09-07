// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/the_rebel_pool/ArcMON.sol";
import "./mocks/MockAquaMON.sol";
import "./mocks/MockERC20.sol";

contract ArcMONTest is Test {
    ArcMON arc;
    MockAquaMON aqua;
    address pool;
    address owner;
    address alice = address(0xA11CE);
    address bob   = address(0xB0B);

    function setUp() public {
        owner = address(this);
        pool = address(0xCAFE);
        aqua = new MockAquaMON();

        // Set up ArcMON, point to mock pool and mock Aqua
        arc = new ArcMON();
        arc.initialize("ArcMON", "wstMON", pool, address(aqua), owner);

        vm.label(owner, "Owner");
        vm.label(pool, "Pool");
        vm.label(address(aqua), "MockAquaMON");
        vm.label(alice, "Alice");
        vm.label(bob, "Bob");

        // Give the contract Aqua to work with for wrapping tests
        aqua.mintShares(alice, 100e18);
    }

    function test_metadata_and_setup() public {
        assertEq(arc.name(), "ArcMON");
        assertEq(arc.symbol(), "wstMON");
        assertEq(arc.decimals(), 18);
        assertEq(arc.pool(), pool);
        assertEq(arc.aqua(), address(aqua));
    }

    function test_wrap_and_unwrap() public {
        uint256 amount = 10e18;

        // Approve ArcMON to pull Aqua
        vm.prank(alice);
        aqua.approve(address(arc), amount);

        // Default pool index is 1e18, so 1:1 conversion
        vm.prank(alice);
        uint256 arcOut = arc.wrap(amount, alice);
        assertEq(arcOut, amount);
        assertEq(arc.balanceOf(alice), amount);

        // Unwrap returns Aqua
        vm.prank(alice);
        uint256 aquaOut = arc.unwrap(amount, alice);
        assertEq(aquaOut, amount);
        assertEq(arc.balanceOf(alice), 0);
    }

    function test_wrapWithPermit() public {
        // Create EIP-2612 permit for Aqua
        uint256 amount = 10e18;
        uint256 privateKey = 0xA11CE;
        address from = vm.addr(privateKey);

        aqua.mintShares(alice, 100e18);

        uint256 nonce = aqua.nonces(from);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _getPermitDigestAqua(
            address(aqua), from, address(arc), amount, nonce, deadline
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);

        // Call wrapWithPermit
        vm.prank(from);
        uint256 arcOut = arc.wrapWithPermit(
            amount, from, amount, deadline, v, r, s
        );
        assertEq(arcOut, amount);
        assertEq(arc.balanceOf(from), amount);
    }

    function _getPermitDigestAqua(
        address token,
        address owner_,
        address spender_,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        // Emulate EIP-2612 digest for Aqua
        bytes32 DOMAIN_SEPARATOR = MockAquaMON(token).DOMAIN_SEPARATOR();
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

    function test_conversion_functions() public {
        // Default index 1e18, conversion 1:1
        assertEq(arc.convertToArc(1e18), 1e18);
        assertEq(arc.convertToAqua(1e18), 1e18);

        // If index changes (simulate by setting on mock pool)
        // You can extend MockPool to return a different index
        // arc.setPool(address(mockPool)); // TODO: implement as needed
    }

    function test_pause_and_reentrancy_guard() public {
        arc.setPause(true);
        vm.expectRevert("Pausable: paused");
        vm.prank(alice);
        arc.wrap(1e18, alice);

        arc.setPause(false);
        vm.prank(alice);
        aqua.approve(address(arc), 1e18);
        arc.wrap(1e18, alice);

        // Reentrancy: call from malicious contract would fail (test with malicious mock if desired)
    }

    function test_onlyOwner_admin_functions() public {
        // Only owner can set pool, aqua, pause, etc.
        vm.prank(alice);
        vm.expectRevert("Ownable: caller is not the owner");
        arc.setPause(true);

        vm.prank(owner);
        arc.setPause(true);
        assertTrue(arc.paused());

        // setPool
        vm.prank(owner);
        arc.setPool(address(0xBEEF));
        assertEq(arc.pool(), address(0xBEEF));

        // setAqua
        vm.prank(owner);
        arc.setAqua(address(0xABCD));
        assertEq(arc.aqua(), address(0xABCD));
    }

    function test_recoverLostTokens_and_blacklist() public {
        MockERC20 token = new MockERC20("Stray", "ST", 18);
        token.mint(address(arc), 42);
        uint256 before = token.balanceOf(owner);

        // Should recover
        arc.recoverLostTokens(address(token), owner, 42);
        assertEq(token.balanceOf(owner), before + 42);

        // Should not recover aqua or arc itself
        vm.expectRevert();
        arc.recoverLostTokens(address(arc), owner, 1);
        vm.expectRevert();
        arc.recoverLostTokens(address(aqua), owner, 1);
    }

    function test_ERC20Votes_delegation() public {
        // Mint and delegate
        vm.prank(alice);
        aqua.approve(address(arc), 2e18);
        vm.prank(alice);
        arc.wrap(2e18, alice);

        vm.prank(alice);
        arc.delegate(bob);

        assertEq(arc.getVotes(bob), 2e18);
    }

    // --- Placeholder for hooks and gasless router ---
    // function test_gasless_wrap_with_relay() public {
    //     // TODO: Simulate forwarder + relay manager
    // }

    // function test_instantUnstakeModule() public {
    //     // TODO: When implemented
    // }
}
