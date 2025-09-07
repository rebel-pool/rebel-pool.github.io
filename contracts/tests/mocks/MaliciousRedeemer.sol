// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../src/the_rebel_pool/StakePoolCore.sol";
import "./MockAquaMON.sol";
import "./MockERC20.sol";

contract MaliciousRedeemer {
    StakePoolCore public pool;
    MockAquaMON public aqua;
    MockERC20 public mon;
    address public owner;

    constructor(address _pool, address _aqua, address _mon) {
        pool = StakePoolCore(_pool);
        aqua = MockAquaMON(_aqua);
        mon = MockERC20(_mon);
        owner = msg.sender;
    }

    // Deposit and try to reenter on redeem
    function attack() external {
        mon.approve(address(pool), 1 ether);
        pool.deposit(1 ether, address(this));
        // Try to start reentrancy
        pool.redeem(1 ether, address(this), address(this));
    }

    // pool calls this when sending tokens on redeem
    receive() external payable {
        // Try to reenter redeem during withdrawal (should fail)
        if (address(pool).balance > 0) {
            try pool.redeem(1 ether, address(this), address(this)) {} catch {}
        }
    }
}
