pragma solidity ^0.8.0;
interface IERC20 { function transfer(address to, uint amt) external returns (bool); }
contract Token is IERC20 {
    mapping(address => uint) balances;
    event Transfer(address indexed from, address indexed to, uint amt);
    function transfer(address to, uint amt) public returns (bool) { _move(msg.sender, to, amt); return true; }
    function _move(address from, address to, uint amt) internal { balances[from] -= amt; balances[to] += amt; emit Transfer(from, to, amt); }
}
