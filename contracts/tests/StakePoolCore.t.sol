// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {StakePoolCore} from "src/the_rebel_pool/StakePoolCore.sol";

import "./mocks/MockERC20.sol";
import "./mocks/MockAquaMON.sol";
import "./mocks/MaliciousRedeemer.sol";

import "forge-std/console2.sol";

error OwnableUnauthorizedAccount(address);
error EnforcedPause();
error ReentrancyGuardReentrantCall();

contract StakePoolCoreTest is Test {
    StakePoolCore public pool;
    MockERC20 public mon;
    MockAquaMON public aqua;
    address public owner;
    address public user;
    address public feeReceiver;

    function setUp() public {
        owner = address(this);
        user = address(0xBEEF);
        feeReceiver = address(0xCAFE);

        mon = new MockERC20("Monad", "MON", 18);
        aqua = new MockAquaMON();

        // Mint test tokens to user
        mon.mint(user, 1_000_000 ether);

        // Deploy and init pool
        pool = new StakePoolCore();
        pool.initialize(owner, address(mon), address(aqua), address(0), 1 ether); // 1 MON/block

        // Set fee receiver for tests
        pool.setFeeParams(100, 0, feeReceiver); // 1% mgmt fee
    }

    // === Main Happy Path Flows ===

    function testDepositMintWithdrawRedeemFlow() public {
        vm.startPrank(user);
        mon.approve(address(pool), 1000 ether);

        // Deposit
        uint256 shares = pool.deposit(100 ether, user);
        assertGt(shares, 0);

        // Withdraw
        uint256 redeemShares = shares / 2;
        uint256 assets = pool.redeem(redeemShares, user, user);
        assertEq(aqua.sharesOf(user), shares - redeemShares);

        // Withdraw all
        uint256 left = aqua.sharesOf(user);
        pool.redeem(left, user, user);
        assertEq(aqua.sharesOf(user), 0);

        vm.stopPrank();
    }

    function testMintAndWithdrawExact() public {
        vm.startPrank(user);
        mon.approve(address(pool), 1000 ether);

        // Mint shares directly
        uint256 assets = pool.mint(100 ether, user);
        assertEq(aqua.sharesOf(user), 100 ether);

        // Withdraw by asset amount
        pool.withdraw(10 ether, user, user);
        assertEq(aqua.sharesOf(user), 90 ether);

        vm.stopPrank();
    }

    // === Error/Edge Conditions ===

    function testRevertsOnZeroAmounts() public {
        vm.expectRevert(StakePoolCore.ZeroAmount.selector);
        pool.deposit(0, user);
        vm.expectRevert(StakePoolCore.ZeroAmount.selector);
        pool.mint(0, user);
        vm.expectRevert(StakePoolCore.ZeroAmount.selector);
        pool.redeem(0, user, user);
        vm.expectRevert(StakePoolCore.ZeroAmount.selector);
        pool.withdraw(0, user, user);
    }

    function testExceedsDepositLimit() public {
        pool.setLimits(10 ether, 0); // max deposit 10 MON
        vm.startPrank(user);
        mon.approve(address(pool), 100 ether);
        vm.expectRevert(StakePoolCore.ExceedsLimit.selector);
        pool.deposit(20 ether, user);
        vm.stopPrank();
    }

    function testExceedsMintLimit() public {
        pool.setLimits(0, 10 ether); // max mint 10 shares
        vm.startPrank(user);
        mon.approve(address(pool), 100 ether);
        vm.expectRevert(StakePoolCore.ExceedsLimit.selector);
        pool.mint(20 ether, user);
        vm.stopPrank();
    }

    function testRevertNotOwnerOfShares() public {
        vm.startPrank(user);
        mon.approve(address(pool), 100 ether);
        pool.deposit(100 ether, user);
        vm.stopPrank();

        address attacker = address(0xF00D);
        vm.prank(attacker);
        vm.expectRevert(StakePoolCore.NotOwnerOfShares.selector);
        pool.redeem(10 ether, attacker, user);
    }

    function testRevertInsufficientShares() public {
        vm.startPrank(user);
        mon.approve(address(pool), 100 ether);
        pool.deposit(100 ether, user);
        vm.stopPrank();

        vm.startPrank(user);
        vm.expectRevert(StakePoolCore.InsufficientShares.selector);
        pool.redeem(200 ether, user, user);
        vm.stopPrank();
    }

    // === Pause, Access Control, Security ===

    function testOnlyOwnerCanPauseAndUpgrade() public {
        vm.prank(user);
        vm.expectRevert();
        pool.pause();

        pool.pause();
        assertTrue(pool.paused());
        pool.unpause();
        assertFalse(pool.paused());
    }

    function testPauseBlocksUserOps() public {
        vm.startPrank(user);
        mon.approve(address(pool), 100 ether);
        pool.deposit(10 ether, user);
        vm.stopPrank();

        pool.pause();

        vm.startPrank(user);
        vm.expectRevert(EnforcedPause.selector);
        pool.deposit(1 ether, user);
        vm.expectRevert(EnforcedPause.selector);
        pool.withdraw(1 ether, user, user);
        vm.expectRevert(EnforcedPause.selector);
        pool.redeem(1 ether, user, user);
        vm.stopPrank();
    }


    // === Fee Logic & Config ===

    function testFeeSkimmingLogic() public {
        vm.startPrank(user);
        mon.approve(address(pool), 100_000 ether);
        pool.deposit(100_000 ether, user);
        vm.stopPrank();

        vm.roll(block.number + 10_000);
        mon.mint(address(pool), 10_000 ether); // or (newTotalAssets - oldTotalAssets)

        pool.accrue();

        uint256 pending = pool.pendingFees();
        console2.log("pending fees", pending);
        console2.log("totalAssets", pool.totalAssets());
        console2.log("balance", mon.balanceOf(address(pool)));

        assertGt(pending, 0);

        pool.skimFees(pending);

        assertEq(mon.balanceOf(feeReceiver), pending);
    }


    function testRevertFeeAboveCap() public {
        // Try to set fee above allowed
        vm.expectRevert("fee too high");
        pool.setFeeParams(2100, 0, feeReceiver);

        vm.expectRevert("perf too high");
        pool.setFeeParams(0, 2100, feeReceiver);
    }

    // === Token Recovery, Safety, Dust/Precision ===

    function testRecoverLostTokens() public {
        // Deploy a random token and send to pool
        MockERC20 lost = new MockERC20("Lost", "LST", 18);
        lost.mint(address(pool), 100 ether);

        // Only owner can recover, cannot recover MON/Aqua/Arc
        pool.recoverLostTokens(address(lost), owner, 100 ether);
        assertEq(lost.balanceOf(owner), 100 ether);

        vm.expectRevert(StakePoolCore.InvalidConfig.selector);
        pool.recoverLostTokens(address(mon), owner, 1 ether);
    }

    function testDustHandling() public {
        vm.startPrank(user);
        mon.approve(address(pool), 100 ether);

        // Deposit odd value that will cause dust on division
        uint256 shares = pool.deposit(1, user);
        // Withdraw all, ensure shares go to zero, assets ~1
        pool.redeem(shares, user, user);
        assertEq(aqua.sharesOf(user), 0);
        vm.stopPrank();
    }

    // === Trusted Forwarder, Gasless Logic ===

    function testSetTrustedForwarder() public {
        address newForwarder = address(0xFAFA);
        pool.setConfig(address(aqua), newForwarder, 2 ether);
        assertEq(pool.trustedForwarder(), newForwarder);
    }

    // === Preview/Conversion Math ===

    function testPreviewFunctions() public {
        vm.startPrank(user);
        mon.approve(address(pool), 100 ether);
        pool.deposit(100 ether, user);
        vm.stopPrank();

        assertEq(pool.convertToShares(100 ether), 100 ether);
        assertEq(pool.convertToAssets(100 ether), 100 ether);
    }

    // == Fuzz tests ===

    function testFuzz_DepositWithdraw(uint256 amount) public {
        amount = bound(amount, 1e9, 1_000_000 ether); // bound input to avoid overflows, min 1 gwei
        vm.startPrank(user);
        mon.mint(user, amount);
        mon.approve(address(pool), amount);

        uint256 shares = pool.deposit(amount, user);
        assertEq(aqua.sharesOf(user), shares);

        pool.redeem(shares, user, user);
        assertEq(aqua.sharesOf(user), 0);

        vm.stopPrank();
    }

    function testDepositEmitsEvent() public {
        vm.startPrank(user);
        mon.approve(address(pool), 100 ether);

        vm.expectEmit(true, true, true, true, address(pool));
        emit StakePoolCore.Deposited(user, 100 ether, 100 ether, user);
        pool.deposit(100 ether, user);

        vm.stopPrank();
    }


}
