pragma solidity ^0.8.0;

library SafeMath {
    function add(uint a, uint b) internal pure returns (uint) { return a + b; }
}

abstract contract Ownable {
    address public owner;
    modifier onlyOwner() { require(msg.sender == owner, "no"); _; }
    function init() internal { owner = msg.sender; }
}

contract Vault is Ownable {
    using SafeMath for uint;
    mapping(address => uint) public deposits;

    function setup() external { init(); }

    function deposit(uint amt) external onlyOwner {
        deposits[msg.sender] = deposits[msg.sender].add(amt);
        record(amt);
    }

    function record(uint amt) internal { deposits[address(this)] = amt; }
}
