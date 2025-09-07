// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";




contract MockAquaMON is ERC20 {
    mapping(address => uint256) public nonces;

    constructor() ERC20("MockAquaMON", "aMON") {}

    function mintShares(address to, uint256 amount) external {
        _mint(to, amount);
    }
    function burnShares(address from, uint256 amount) external {
        _burn(from, amount);
    }
    function sharesOf(address user) external view returns (uint256) {
        return balanceOf(user);
    }

    function DOMAIN_SEPARATOR() external pure returns (bytes32) {
        return 0x0;
    }

    function permit(
        address, address, uint256, uint256, uint8, bytes32, bytes32
    ) external pure {}
}
